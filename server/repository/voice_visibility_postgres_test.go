package repository

import (
	"context"
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"reflect"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/jackc/pgx/v5"
)

// The voice state fanout's audience statement, as it was before the array
// parameters: one placeholder per connected candidate and one channel per
// statement. Kept here, verbatim, as the reference the new statement must
// agree with on the same rows.
func legacyVoiceVisibleUsers(ctx context.Context, db database.TxQuerier, serverID, channelID string, online []string) ([]string, error) {
	if len(online) == 0 {
		return nil, nil
	}
	args := make([]any, 0, len(online)+2)
	args = append(args, serverID, channelID)
	for _, id := range online {
		args = append(args, id)
	}
	query := `SELECT m.user_id,bit_or(r.permissions),COALESCE(bit_or(o.allow),0),COALESCE(bit_or(o.deny),0)
	FROM channels c
	JOIN server_members m ON m.server_id=c.server_id
	JOIN user_roles ur ON ur.user_id=m.user_id AND ur.server_id=m.server_id
	JOIN roles r ON r.id=ur.role_id AND r.server_id=c.server_id
	LEFT JOIN channel_permissions o ON o.channel_id=c.id AND o.role_id=r.id
	WHERE c.server_id=? AND c.id=? AND c.type='voice' AND m.user_id IN (` + strings.TrimSuffix(strings.Repeat("?,", len(online)), ",") + `) GROUP BY m.user_id`
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var visible []string
	for rows.Next() {
		var id string
		var base, allow, deny models.Permission
		if err := rows.Scan(&id, &base, &allow, &deny); err != nil {
			return nil, err
		}
		if models.EffectiveChannelPermission(base, allow, deny).Has(models.PermViewChannel) {
			visible = append(visible, id)
		}
	}
	return visible, rows.Err()
}

func sortedIDs(ids []string) []string {
	sorted := append([]string{}, ids...)
	sort.Strings(sorted)
	return sorted
}

// Named members of the fixture, in the order audiences are built from.
var voiceVisibilityNamed = []string{"viewer", "plain", "admin", "both", "norole", "outsider", "foreign", "crossrole", "wrongsrv"}

const voiceVisibilityBulk = 600

// seedVoiceVisibility builds one server ("guild") whose channels and roles
// cover every branch of the visibility rule, plus a second server ("other")
// whose rows must never leak into guild's audiences.
func seedVoiceVisibility(t testing.TB, d *database.DB) {
	t.Helper()
	view, connect := int64(models.PermViewChannel), int64(models.PermConnectVoice)
	seed := []seedStmt{
		{q: "INSERT INTO users(id,username,password_hash) SELECT id,id,'x' FROM unnest(?::text[]) AS id", args: []any{voiceVisibilityNamed}},
		{q: "INSERT INTO users(id,username,password_hash) SELECT 'u'||lpad(n::text,4,'0'),'u'||lpad(n::text,4,'0'),'x' FROM generate_series(1,?::int) AS n", args: []any{voiceVisibilityBulk}},
		{q: "INSERT INTO servers(id,name,owner_id) VALUES('guild','guild','admin'),('other','other','foreign')"},
		// outsider is in no server; foreign only in the other one.
		{q: "INSERT INTO server_members(server_id,user_id) VALUES('guild','viewer'),('guild','plain'),('guild','admin'),('guild','both'),('guild','norole'),('guild','crossrole'),('guild','wrongsrv'),('other','foreign'),('other','crossrole')"},
		{q: "INSERT INTO server_members(server_id,user_id) SELECT 'guild','u'||lpad(n::text,4,'0') FROM generate_series(1,?::int) AS n", args: []any{voiceVisibilityBulk}},
		{q: "INSERT INTO roles(id,server_id,name,permissions) VALUES('r_view','guild','view',?),('r_plain','guild','plain',?),('r_admin','guild','admin',?),('r_deaf','guild','deaf',0),('o_view','other','view',?)",
			args: []any{view | connect, connect, int64(models.PermAdmin), view | connect}},
		// outsider holds a guild role without being a member, crossrole a
		// role of the other server recorded for guild, wrongsrv a guild role
		// recorded for the other server: none of the three may be selected.
		{q: `INSERT INTO user_roles(user_id,role_id,server_id) VALUES
			('viewer','r_view','guild'),('plain','r_plain','guild'),('admin','r_admin','guild'),
			('both','r_view','guild'),('both','r_deaf','guild'),
			('outsider','r_view','guild'),
			('foreign','o_view','other'),
			('crossrole','o_view','guild'),
			('wrongsrv','r_view','other')`},
		// Two of three bulk members can view through their role; every fifth
		// also holds the role the mixed channel grants an override to.
		{q: "INSERT INTO user_roles(user_id,role_id,server_id) SELECT 'u'||lpad(n::text,4,'0'),CASE WHEN n%3=0 THEN 'r_plain' ELSE 'r_view' END,'guild' FROM generate_series(1,?::int) AS n", args: []any{voiceVisibilityBulk}},
		{q: "INSERT INTO user_roles(user_id,role_id,server_id) SELECT 'u'||lpad(n::text,4,'0'),'r_deaf','guild' FROM generate_series(1,?::int) AS n WHERE n%5=0", args: []any{voiceVisibilityBulk}},
		{q: `INSERT INTO channels(id,server_id,name,type) VALUES
			('v_open','guild','open','voice'),('v_denied','guild','denied','voice'),
			('v_allowed','guild','allowed','voice'),('v_mixed','guild','mixed','voice'),
			('t_text','guild','text','text'),('o_voice','other','voice','voice')`},
		{q: `INSERT INTO channel_permissions(channel_id,role_id,allow,deny) VALUES
			('v_denied','r_view',0,?),
			('v_allowed','r_view',0,?),('v_allowed','r_plain',?,0),
			('v_mixed','r_view',0,?),('v_mixed','r_deaf',?,0),
			('t_text','r_view',?,0)`, args: []any{view, view, view, view, view, view}},
	}
	execSeed(t, d, seed)
}

// voiceVisibilityAudience returns exactly n candidates. From 50 up the list
// also carries what a live online list can: a duplicate, an empty id and an
// id that belongs to nobody.
func voiceVisibilityAudience(n int) []string {
	audience := make([]string, 0, n)
	if n >= 50 {
		audience = append(audience, "viewer", "", "ghost")
	}
	for _, id := range voiceVisibilityNamed {
		if len(audience) < n {
			audience = append(audience, id)
		}
	}
	for i := 1; len(audience) < n; i++ {
		audience = append(audience, fmt.Sprintf("u%04d", i))
	}
	return audience
}

func TestPostgresVoiceVisibleUsersByChannelMatchesLegacyStatement(t *testing.T) {
	if os.Getenv("HICHAT_TEST_POSTGRES_DSN") == "" {
		t.Skip("requires local PostgreSQL")
	}
	d := newTestDB(t)
	seedVoiceVisibility(t, d)
	ctx := context.Background()
	db := wrapForRepo(d)
	repo := NewSQLiteChannelRepo(db).VoiceAccess()

	// What the rule yields for the named members, stated independently of
	// either statement, so that two statements agreeing on nothing cannot pass.
	want := map[string][]string{
		"v_open":    {"admin", "both", "viewer"},
		"v_denied":  {"admin"},
		"v_allowed": {"admin", "plain"},
		"v_mixed":   {"admin", "both"},
	}
	everyChannel := []string{"v_open", "v_denied", "v_allowed", "v_mixed", "t_text", "o_voice", "missing"}
	got, err := repo.VoiceVisibleUsersByChannel(ctx, "guild", everyChannel, voiceVisibilityNamed)
	if err != nil {
		t.Fatal(err)
	}
	for channelID := range got {
		got[channelID] = sortedIDs(got[channelID])
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("named audiences\n got %v\nwant %v", got, want)
	}

	channelSets := [][]string{
		{"v_open"}, {"v_denied"}, {"v_allowed"}, {"v_mixed"}, {"t_text"}, {"o_voice"}, {"missing"},
		{"v_open", "v_denied"}, {"v_mixed", "t_text"}, {"v_allowed", "o_voice"},
		everyChannel,
		{"v_open", "v_open", "v_mixed"},
	}
	audiences := map[string][]string{
		"empty":        {},
		"nil":          nil,
		"blank only":   {""},
		"unknown only": {"ghost"},
		"duplicate":    {"viewer", "viewer"},
		"blank first":  {"", "both"},
	}
	for _, n := range []int{1, 2, 50, voiceVisibilityBulk} {
		audience := voiceVisibilityAudience(n)
		if len(audience) != n {
			t.Fatalf("audience of %d has %d entries", n, len(audience))
		}
		audiences[fmt.Sprintf("size %d", n)] = audience
	}
	compared, nonEmpty := 0, 0
	for name, audience := range audiences {
		for _, channelIDs := range channelSets {
			byChannel, err := repo.VoiceVisibleUsersByChannel(ctx, "guild", channelIDs, audience)
			if err != nil {
				t.Fatalf("%s %v: %v", name, channelIDs, err)
			}
			for channelID, ids := range byChannel {
				if !slices.Contains(channelIDs, channelID) {
					t.Fatalf("%s %v: audience for unrequested channel %q", name, channelIDs, channelID)
				}
				if unique := slices.Compact(sortedIDs(ids)); len(unique) != len(ids) {
					t.Fatalf("%s %v channel %s: a recipient is listed twice: %v", name, channelIDs, channelID, ids)
				}
			}
			for _, channelID := range channelIDs {
				legacy, err := legacyVoiceVisibleUsers(ctx, db, "guild", channelID, audience)
				if err != nil {
					t.Fatalf("%s legacy %s: %v", name, channelID, err)
				}
				if got, want := sortedIDs(byChannel[channelID]), sortedIDs(legacy); !reflect.DeepEqual(got, want) {
					t.Fatalf("%s %v channel %s\n got %v\nwant %v", name, channelIDs, channelID, got, want)
				}
				single, err := repo.VoiceVisibleUsers(ctx, "guild", channelID, audience)
				if err != nil {
					t.Fatalf("%s single %s: %v", name, channelID, err)
				}
				if got, want := sortedIDs(single), sortedIDs(legacy); !reflect.DeepEqual(got, want) {
					t.Fatalf("%s single channel %s\n got %v\nwant %v", name, channelID, got, want)
				}
				compared++
				if len(legacy) > 0 {
					nonEmpty++
				}
			}
		}
	}
	if compared == 0 || nonEmpty < 20 {
		t.Fatalf("comparison too thin: %d compared, %d with recipients", compared, nonEmpty)
	}
	// The 600 candidates are viewer (a second time), "", ghost, the nine
	// named and 588 bulk members, of whom two in three view by role.
	open, err := repo.VoiceVisibleUsers(ctx, "guild", "v_open", voiceVisibilityAudience(voiceVisibilityBulk))
	if err != nil {
		t.Fatal(err)
	}
	if want := 3 + (588 - 588/3); len(open) != want {
		t.Fatalf("v_open audience of the 600: %d, want %d", len(open), want)
	}

	// The server scope is part of the rule: the same channels asked for
	// another server select what the legacy statement selects there.
	for _, serverID := range []string{"other", "guild", "missing"} {
		byChannel, err := repo.VoiceVisibleUsersByChannel(ctx, serverID, everyChannel, voiceVisibilityNamed)
		if err != nil {
			t.Fatal(err)
		}
		for _, channelID := range everyChannel {
			legacy, err := legacyVoiceVisibleUsers(ctx, db, serverID, channelID, voiceVisibilityNamed)
			if err != nil {
				t.Fatal(err)
			}
			if got, want := sortedIDs(byChannel[channelID]), sortedIDs(legacy); !reflect.DeepEqual(got, want) {
				t.Fatalf("server %s channel %s\n got %v\nwant %v", serverID, channelID, got, want)
			}
		}
		if serverID == "other" && !reflect.DeepEqual(byChannel, map[string][]string{"o_voice": {"foreign"}}) {
			t.Fatalf("other server's audiences: %v", byChannel)
		}
		if serverID == "missing" && len(byChannel) != 0 {
			t.Fatalf("unknown server's audiences: %v", byChannel)
		}
	}

	// A revocation committed between two calls is seen by the next one.
	execSeed(t, d, []seedStmt{{q: "DELETE FROM server_members WHERE server_id='guild' AND user_id='viewer'"}})
	after, err := repo.VoiceVisibleUsersByChannel(ctx, "guild", []string{"v_open", "v_mixed"}, voiceVisibilityNamed)
	if err != nil {
		t.Fatal(err)
	}
	if got := sortedIDs(after["v_open"]); !reflect.DeepEqual(got, []string{"admin", "both"}) {
		t.Fatalf("v_open after the member left: %v", got)
	}
	if nothing, err := repo.VoiceVisibleUsersByChannel(ctx, "guild", nil, voiceVisibilityNamed); err != nil || len(nothing) != 0 {
		t.Fatalf("no channels: %v err %v", nothing, err)
	}
}

// pgWireCounter counts what one test pool sends: frontend messages by type
// and the writes that carry a Parse or a Bind. One such write is one trip to
// the server that the caller waits for.
type pgWireCounter struct {
	mu       sync.Mutex
	messages map[byte]int
	flushes  int
}

func (c *pgWireCounter) reset() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.messages, c.flushes = map[byte]int{}, 0
}

func (c *pgWireCounter) snapshot() (parses, binds, flushes int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.messages['P'], c.messages['B'], c.flushes
}

type pgCountingConn struct {
	net.Conn
	counter *pgWireCounter
	started bool // the startup packet has no type byte
}

func (c *pgCountingConn) Write(p []byte) (int, error) {
	if !c.started {
		c.started = true
		return c.Conn.Write(p)
	}
	c.counter.mu.Lock()
	counted := false
	for rest := p; len(rest) >= 5; {
		kind, size := rest[0], int(binary.BigEndian.Uint32(rest[1:5]))
		if size < 4 || 1+size > len(rest) {
			break
		}
		c.counter.messages[kind]++
		if (kind == 'P' || kind == 'B') && !counted {
			counted = true
			c.counter.flushes++
		}
		rest = rest[1+size:]
	}
	c.counter.mu.Unlock()
	return c.Conn.Write(p)
}

// newCountingVoicePool opens a second pool on the test schema that holds a
// single connection, so every statement shares one pgx statement cache and
// one pg_prepared_statements view.
func newCountingVoicePool(t *testing.T, dsn string) (*sql.DB, *pgWireCounter) {
	t.Helper()
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(cfg.RuntimeParams["search_path"], "hichat_test_") {
		t.Fatal("counting pool requires the isolated test schema")
	}
	counter := &pgWireCounter{messages: map[byte]int{}}
	dialer := &net.Dialer{}
	cfg.DialFunc = func(ctx context.Context, network, addr string) (net.Conn, error) {
		conn, err := dialer.DialContext(ctx, network, addr)
		if err != nil {
			return nil, err
		}
		return &pgCountingConn{Conn: conn, counter: counter}, nil
	}
	pool := database.PostgreSQLPool(cfg)
	pool.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = pool.Close() })
	return pool, counter
}

func TestPostgresVoiceVisibilityStatementIsPreparedOnce(t *testing.T) {
	if os.Getenv("HICHAT_TEST_POSTGRES_DSN") == "" {
		t.Skip("requires local PostgreSQL")
	}
	d, dsn := newTestDBWithPath(t)
	seedVoiceVisibility(t, d)
	ctx := context.Background()
	pool, wire := newCountingVoicePool(t, dsn)
	db := database.NewRetryingQuerier(pool)
	repo := NewSQLiteChannelRepo(db).VoiceAccess()
	if repo == nil {
		t.Fatal("PostgreSQL pool did not select the snapshot voice access reader")
	}
	backend := func() (pid int) {
		t.Helper()
		if err := pool.QueryRowContext(ctx, "SELECT pg_backend_pid()").Scan(&pid); err != nil {
			t.Fatal(err)
		}
		return pid
	}
	// Every execution of a prepared statement is planned as either a generic
	// or a custom plan, so the two counters add up to its executions.
	const cachedStatements = `SELECT name, parameter_types::text, generic_plans, custom_plans FROM pg_prepared_statements
		WHERE statement LIKE '%bit_or(r.permissions)%' AND statement LIKE ? AND statement NOT LIKE '%pg_prepared_statements%'`
	prepared := func(like string) (names []string, parameterTypes string, executions int) {
		t.Helper()
		rows, err := pool.QueryContext(ctx, cachedStatements, like)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		for rows.Next() {
			var name string
			var generic, custom int
			if err := rows.Scan(&name, &parameterTypes, &generic, &custom); err != nil {
				t.Fatal(err)
			}
			names = append(names, name)
			executions += generic + custom
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		return names, parameterTypes, executions
	}
	pid := backend()
	sizes := []int{1, 2, 50, voiceVisibilityBulk}
	channelSets := [][]string{{"v_open"}, {"v_open", "v_mixed"}, {"v_open", "v_denied", "v_allowed", "v_mixed", "t_text"}}

	// Before: the placeholder list makes every audience size its own
	// statement, each prepared (one extra trip) the first time it is seen.
	wire.reset()
	for _, n := range sizes {
		if _, err := legacyVoiceVisibleUsers(ctx, db, "guild", "v_open", voiceVisibilityAudience(n)); err != nil {
			t.Fatal(err)
		}
	}
	legacyParses, legacyBinds, legacyFlushes := wire.snapshot()
	legacyNames, _, _ := prepared("%m.user_id IN (%")
	if legacyParses != len(sizes) || legacyBinds != len(sizes) || len(legacyNames) != len(sizes) {
		t.Fatalf("legacy statement: %d prepares, %d executions, %d cached statements for %d audience sizes", legacyParses, legacyBinds, len(legacyNames), len(sizes))
	}

	// After: one statement text whatever the audience and the channel count.
	wire.reset()
	calls := 0
	for round := 0; round < 2; round++ {
		for _, n := range sizes {
			for _, channelIDs := range channelSets {
				byChannel, err := repo.VoiceVisibleUsersByChannel(ctx, "guild", channelIDs, voiceVisibilityAudience(n))
				if err != nil {
					t.Fatal(err)
				}
				if len(byChannel["v_open"]) == 0 {
					t.Fatalf("no audience for v_open with %d candidates", n)
				}
				calls++
			}
			if _, err := repo.VoiceVisibleUsers(ctx, "guild", "v_mixed", voiceVisibilityAudience(n)); err != nil {
				t.Fatal(err)
			}
			calls++
		}
	}
	parses, binds, flushes := wire.snapshot()
	names, parameterTypes, executions := prepared("%m.user_id=ANY($2)%c.id=ANY($4)%")
	if parses != 1 || binds != calls {
		t.Fatalf("array statement: %d prepares and %d executions for %d calls, want 1 prepare", parses, binds, calls)
	}
	if len(names) != 1 || executions != calls {
		t.Fatalf("array statement: cached as %v with %d executions, want one statement run %d times", names, executions, calls)
	}
	if parameterTypes != "{text,text[],text,text[]}" {
		t.Fatalf("array statement parameters bound as %s", parameterTypes)
	}
	if flushes != calls+1 {
		t.Fatalf("array statement: %d trips for %d calls, want one prepare plus one per call", flushes, calls)
	}
	if now := backend(); now != pid {
		t.Fatalf("pool changed connection (%d -> %d); the counts above span two statement caches", pid, now)
	}
	t.Logf("legacy: %d audience sizes -> %d prepares, %d trips, %d cached statements; array: %d calls -> %d prepare, %d trips, 1 cached statement",
		len(sizes), legacyParses, legacyFlushes, len(legacyNames), calls, parses, flushes)
}

// seedVoiceVisibilityPlanShape builds the data shape on which joining the
// channel list directly was measurably slower than one statement per channel:
// one server with 5,000 members, 10 roles and 50 channels plus 1,500 thread
// rows, next to 300 small servers, and a channel_permissions table of 141 rows.
func seedVoiceVisibilityPlanShape(t testing.TB, d *database.DB) {
	t.Helper()
	execSeed(t, d, []seedStmt{
		{q: "INSERT INTO users(id,username,password_hash) SELECT 'bm'||lpad(n::text,4,'0'),'bm'||lpad(n::text,4,'0'),'x' FROM generate_series(1,5000) n"},
		{q: "INSERT INTO users(id,username,password_hash) SELECT 'sm'||s||'_'||n,'sm'||s||'_'||n,'x' FROM generate_series(1,300) s, generate_series(1,20) n"},
		{q: "INSERT INTO servers(id,name,owner_id) VALUES('big','big','bm0001')"},
		{q: "INSERT INTO servers(id,name,owner_id) SELECT 's'||s,'s'||s,'sm'||s||'_1' FROM generate_series(1,300) s"},
		{q: "INSERT INTO server_members(server_id,user_id) SELECT 'big','bm'||lpad(n::text,4,'0') FROM generate_series(1,5000) n"},
		{q: "INSERT INTO server_members(server_id,user_id) SELECT 's'||s,'sm'||s||'_'||n FROM generate_series(1,300) s, generate_series(1,20) n"},
		{q: "INSERT INTO roles(id,server_id,name,permissions) SELECT 'bigrole'||lpad(n::text,2,'0'),'big','r'||n,?::bigint FROM generate_series(1,10) n", args: []any{int64(models.PermViewChannel)}},
		{q: "INSERT INTO roles(id,server_id,name,permissions) SELECT 'sr'||s||'_'||n,'s'||s,'r',0 FROM generate_series(1,300) s, generate_series(1,3) n"},
		{q: "INSERT INTO user_roles(user_id,role_id,server_id) SELECT 'bm'||lpad(n::text,4,'0'),'bigrole'||lpad((1+n%10)::text,2,'0'),'big' FROM generate_series(1,5000) n"},
		{q: "INSERT INTO user_roles(user_id,role_id,server_id) SELECT 'bm'||lpad(n::text,4,'0'),'bigrole'||lpad((1+(n+3)%10)::text,2,'0'),'big' FROM generate_series(1,5000) n WHERE n%10<3"},
		{q: "INSERT INTO user_roles(user_id,role_id,server_id) SELECT 'sm'||s||'_'||n,'sr'||s||'_'||(1+n%3),'s'||s FROM generate_series(1,300) s, generate_series(1,20) n"},
		{q: "INSERT INTO channels(id,server_id,name,type) SELECT 'bigchan'||lpad(n::text,2,'0'),'big','c'||n,CASE WHEN n%10<3 THEN 'voice' ELSE 'text' END FROM generate_series(1,50) n"},
		{q: "INSERT INTO channels(id,server_id,name,type,parent_channel_id) SELECT 'bigthread'||n,'big','t'||n,'thread','bigchan03' FROM generate_series(1,1500) n"},
		{q: "INSERT INTO channels(id,server_id,name,type) SELECT 'sc'||s||'_'||n,'s'||s,'c',CASE WHEN n<4 THEN 'voice' ELSE 'text' END FROM generate_series(1,300) s, generate_series(1,10) n"},
		{q: "INSERT INTO channel_permissions(channel_id,role_id,allow,deny) SELECT 'bigchan'||lpad(c::text,2,'0'),'bigrole'||lpad(r::text,2,'0'),0,0 FROM generate_series(1,20) c, generate_series(1,2) r"},
		{q: "INSERT INTO channel_permissions(channel_id,role_id,allow,deny) SELECT 'sc'||s||'_'||c,'sr'||s||'_1',0,0 FROM generate_series(1,300) s, generate_series(1,3) c WHERE (s-1)*3+c<=101"},
		{q: "VACUUM ANALYZE users"}, {q: "VACUUM ANALYZE server_members"}, {q: "VACUUM ANALYZE roles"},
		{q: "VACUUM ANALYZE user_roles"}, {q: "VACUUM ANALYZE channels"}, {q: "VACUUM ANALYZE channel_permissions"},
	})
}

// voicePlanScans collects, from an EXPLAIN (FORMAT JSON) plan tree, the nodes
// that read the given relation.
func voicePlanScans(node map[string]any, relation string, into *[]map[string]any) {
	if node["Relation Name"] == relation {
		*into = append(*into, node)
	}
	children, _ := node["Plans"].([]any)
	for _, child := range children {
		if childNode, ok := child.(map[string]any); ok {
			voicePlanScans(childNode, relation, into)
		}
	}
}

// The audience statement must keep, for every channel it is asked about, the
// plan shape a statement for that one channel had: the channel rows are read
// once, not once per candidate, and an index lookup of the overrides is keyed
// by the channel. Both are checked under a value-specific and under a generic
// plan, because PostgreSQL uses the first for the first executions on a
// connection and may settle on either.
func TestPostgresVoiceVisibilityPlanKeepsPerChannelShape(t *testing.T) {
	if os.Getenv("HICHAT_TEST_POSTGRES_DSN") == "" {
		t.Skip("requires local PostgreSQL")
	}
	d := newTestDB(t)
	seedVoiceVisibilityPlanShape(t, d)
	ctx := context.Background()
	var overrides int
	if err := d.Conn.QueryRowContext(ctx, "SELECT count(*) FROM channel_permissions").Scan(&overrides); err != nil || overrides != 141 {
		t.Fatalf("fixture has %d channel_permissions rows (err %v), want 141", overrides, err)
	}
	online := make([]string, 0, 600)
	for i := 1; i <= 600; i++ {
		online = append(online, fmt.Sprintf("bm%04d", i*8))
	}
	channelIDs := []string{"bigchan01", "bigchan10"}
	visible, err := NewSQLiteChannelRepo(wrapForRepo(d)).VoiceAccess().VoiceVisibleUsersByChannel(ctx, "big", channelIDs, online)
	if err != nil || len(visible["bigchan01"]) != 600 || len(visible["bigchan10"]) != 600 {
		t.Fatalf("audiences %d and %d (err %v), want 600 each", len(visible["bigchan01"]), len(visible["bigchan10"]), err)
	}

	textArray := func(ids []string) string { return "ARRAY['" + strings.Join(ids, "','") + "']::text[]" }
	// One literal per placeholder of voiceVisibleUsersQuery, in its order.
	literals := []string{"'big'", textArray(online), "'big'", textArray(channelIDs)}
	statement, types := voiceVisibleUsersQuery, make([]string, 0, len(literals))
	for i, literal := range literals {
		statement = strings.Replace(statement, "?", fmt.Sprintf("$%d", i+1), 1)
		types = append(types, map[bool]string{true: "text[]", false: "text"}[strings.HasPrefix(literal, "ARRAY")])
	}
	if strings.Contains(statement, "?") {
		t.Fatalf("statement has more placeholders than the test binds: %s", statement)
	}
	conn, err := d.Conn.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, "PREPARE voice_plan_shape("+strings.Join(types, ",")+") AS "+statement); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"force_custom_plan", "force_generic_plan"} {
		if _, err := conn.ExecContext(ctx, "SET plan_cache_mode="+mode); err != nil {
			t.Fatal(err)
		}
		var raw string
		if err := conn.QueryRowContext(ctx, "EXPLAIN (ANALYZE, FORMAT JSON) EXECUTE voice_plan_shape("+strings.Join(literals, ",")+")").Scan(&raw); err != nil {
			t.Fatalf("%s: %v", mode, err)
		}
		var explained []struct {
			Plan map[string]any `json:"Plan"`
		}
		if err := json.Unmarshal([]byte(raw), &explained); err != nil || len(explained) != 1 {
			t.Fatalf("%s: plan not decoded (%v): %s", mode, err, raw)
		}
		var channelScans, overrideScans []map[string]any
		voicePlanScans(explained[0].Plan, "channels", &channelScans)
		voicePlanScans(explained[0].Plan, "channel_permissions", &overrideScans)
		if len(channelScans) != 1 || len(overrideScans) == 0 {
			t.Fatalf("%s: %d scans of channels and %d of channel_permissions in the plan: %s", mode, len(channelScans), len(overrideScans), raw)
		}
		if loops, _ := channelScans[0]["Actual Loops"].(float64); loops != 1 {
			t.Errorf("%s: the channel rows were read %v times, want once for the whole audience", mode, loops)
		}
		for _, scan := range overrideScans {
			condition, indexed := scan["Index Cond"].(string)
			if indexed && !strings.Contains(condition, "channel_id") {
				t.Errorf("%s: override lookup is not keyed by the channel: Index Cond %s over %v loops", mode, condition, scan["Actual Loops"])
			}
		}
	}
}
