package services

import (
	"context"
	"database/sql"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg/crypto"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"

	livekit "github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/proto"
)

// ─── Voice join and move against PostgreSQL ───
//
// Every other voice test in this package answers the snapshot reads from a
// fake. These wire the voice service the way initVoiceRuntimeServices does
// for PostgreSQL — the channel repository's VoiceAccess reader, the real
// permission service as cached and fresh resolver, the real LiveKit, server,
// timeout and ban repositories — and run JoinChannel and MoveUser on real
// rows, so what the fakes assume about the statements is checked once
// against the database that runs them in production.

type voicePGStatement struct {
	query string
	args  []any
}

// voicePGRecorder sits where initRepositories puts the retrying querier and
// records every statement the repositories issue through it.
type voicePGRecorder struct {
	db database.TxQuerier

	mu         sync.Mutex
	statements []voicePGStatement
}

func (r *voicePGRecorder) Unwrap() database.TxQuerier { return r.db }

func (r *voicePGRecorder) record(query string, args []any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.statements = append(r.statements, voicePGStatement{strings.Join(strings.Fields(query), " "), slices.Clone(args)})
}

func (r *voicePGRecorder) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	r.record(query, args)
	return r.db.ExecContext(ctx, query, args...)
}

func (r *voicePGRecorder) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	r.record(query, args)
	return r.db.QueryContext(ctx, query, args...)
}

func (r *voicePGRecorder) QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row {
	r.record(query, args)
	return r.db.QueryRowContext(ctx, query, args...)
}

// take returns and clears the statements recorded so far.
func (r *voicePGRecorder) take() []voicePGStatement {
	r.mu.Lock()
	defer r.mu.Unlock()
	statements := r.statements
	r.statements = nil
	return statements
}

func voicePGMatching(statements []voicePGStatement, fragment string) []voicePGStatement {
	var matching []voicePGStatement
	for _, statement := range statements {
		if strings.Contains(statement.query, fragment) {
			matching = append(matching, statement)
		}
	}
	return matching
}

// voicePGSummary names each statement by its first words, for the log.
func voicePGSummary(statements []voicePGStatement) []string {
	summary := make([]string, len(statements))
	for i, statement := range statements {
		summary[i] = statement.query[:min(len(statement.query), 56)]
	}
	return summary
}

// Fragments that identify the three snapshot statements of
// repository/voice_access.go and any read of the LiveKit instance table.
const (
	voicePGTokenRead      = "WITH a AS ("
	voicePGAdmissionRead  = "SELECT c.id, c.server_id, c.type, c.user_limit"
	voicePGVisibilityRead = "c.id=ANY(?)"
	voicePGInstanceTable  = "livekit_instances"
)

// voicePGAccess is the real reader with two test hooks in front of it.
type voicePGAccess struct {
	repository.VoiceAccessReader

	mu          sync.Mutex
	tokenReads  int
	onTokenRead func(read int)        // before the statement, with the read's number
	onVisible   func(serverID string) // before the visibility statement
}

func (a *voicePGAccess) VoiceTokenAccess(ctx context.Context, userID, channelID string, now time.Time) (*models.VoiceAdmission, *models.LiveKitInstance, int64, error) {
	a.mu.Lock()
	a.tokenReads++
	read, hook := a.tokenReads, a.onTokenRead
	a.mu.Unlock()
	if hook != nil {
		hook(read)
	}
	return a.VoiceAccessReader.VoiceTokenAccess(ctx, userID, channelID, now)
}

func (a *voicePGAccess) VoiceVisibleUsersByChannel(ctx context.Context, serverID string, channelIDs, online []string) (map[string][]string, error) {
	a.mu.Lock()
	hook := a.onVisible
	a.mu.Unlock()
	if hook != nil {
		hook(serverID)
	}
	return a.VoiceAccessReader.VoiceVisibleUsersByChannel(ctx, serverID, channelIDs, online)
}

// voicePGPermissions is the real permission service; onResolve runs before
// each cached-resolver read (the mover's permission reads of a move).
type voicePGPermissions struct {
	ChannelPermissionRuntime
	mu        sync.Mutex
	onResolve func()
}

func (p *voicePGPermissions) ResolveChannelPermissions(ctx context.Context, userID, channelID string) (models.Permission, error) {
	p.mu.Lock()
	hook := p.onResolve
	p.mu.Unlock()
	if hook != nil {
		hook()
	}
	return p.ChannelPermissionRuntime.ResolveChannelPermissions(ctx, userID, channelID)
}

// voicePGLiveKit is the real LiveKit repository, counting instance lookups.
type voicePGLiveKit struct {
	repository.LiveKitStore
	mu      sync.Mutex
	lookups []string
}

func (l *voicePGLiveKit) GetByServerID(ctx context.Context, serverID string) (*models.LiveKitInstance, error) {
	l.mu.Lock()
	l.lookups = append(l.lookups, serverID)
	l.mu.Unlock()
	return l.LiveKitStore.GetByServerID(ctx, serverID)
}

func (l *voicePGLiveKit) lookedUp() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return slices.Clone(l.lookups)
}

type voicePGPublication struct {
	channelID, action string
	audience          []string
}

type voicePGHub struct {
	testutil.MockBroadcaster
	online map[string][]string
}

func (h *voicePGHub) GetOnlineUserIDsForServer(serverID string) []string { return h.online[serverID] }

type voicePGFixture struct {
	db        *sql.DB
	svc       *voiceService
	recorder  *voicePGRecorder
	access    *voicePGAccess
	perms     *voicePGPermissions
	livekit   *voicePGLiveKit
	userSends chan moveSnapshotUserEvent // BroadcastToUser
	published chan voicePGPublication    // voice state updates the fanout published

	mu      sync.Mutex
	removed []string // "room identity" per RemoveParticipant the fake LiveKit received
}

// newVoicePGFixture seeds two servers in an isolated schema: "guild" with a
// LiveKit instance linked and two voice channels, "bare" with none.
//
//	admin      moderator role (administrator) in both servers
//	victim     plain member in both
//	bystander  plain member of guild
//	limited    member of guild whose role is denied ViewChannel on v2
func newVoicePGFixture(t *testing.T) *voicePGFixture {
	t.Helper()
	db := postgresServerFixture(t)
	f := &voicePGFixture{
		db:        db,
		userSends: make(chan moveSnapshotUserEvent, 16),
		published: make(chan voicePGPublication, 64),
	}
	livekitServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var request livekit.RoomParticipantIdentity
		if r.URL.Path == "/twirp/livekit.RoomService/RemoveParticipant" && proto.Unmarshal(body, &request) == nil {
			f.mu.Lock()
			f.removed = append(f.removed, request.Room+" "+request.Identity)
			f.mu.Unlock()
		}
		w.Header().Set("Content-Type", "application/protobuf")
	}))
	t.Cleanup(livekitServer.Close)

	encrypt := func(value string) string {
		encrypted, err := crypto.Encrypt(value, tokenTestEncryptionKey)
		if err != nil {
			t.Fatalf("setup: encrypt: %v", err)
		}
		return encrypted
	}
	member := int64(models.PermViewChannel | models.PermConnectVoice | models.PermSpeak)
	seed := []voicePGStatement{
		{"INSERT INTO users(id,username,password_hash) VALUES('admin','admin','x'),('victim','victim','x'),('bystander','bystander','x'),('limited','limited','x')", nil},
		{"INSERT INTO livekit_instances(id,url,api_key,api_secret,is_platform_managed,auto_switch_enabled) VALUES('sfu',?,?,?,0,0)",
			[]any{livekitServer.URL, encrypt(tokenTestAPIKey), encrypt(tokenTestAPISecret)}},
		{"INSERT INTO servers(id,name,owner_id,livekit_instance_id) VALUES('guild','guild','admin','sfu'),('bare','bare','admin',NULL)", nil},
		{"INSERT INTO server_members(server_id,user_id) VALUES('guild','admin'),('guild','victim'),('guild','bystander'),('guild','limited'),('bare','admin'),('bare','victim')", nil},
		{"INSERT INTO channels(id,server_id,name,type) VALUES('v1','guild','one','voice'),('v2','guild','two','voice'),('b1','bare','one','voice'),('b2','bare','two','voice')", nil},
		{"INSERT INTO roles(id,server_id,name,permissions) VALUES('g_mod','guild','mod',?),('g_member','guild','member',?),('g_limited','guild','limited',?),('b_mod','bare','mod',?),('b_member','bare','member',?)",
			[]any{int64(models.PermAdmin), member, member, int64(models.PermAdmin), member}},
		{"INSERT INTO user_roles(user_id,role_id,server_id) VALUES('admin','g_mod','guild'),('victim','g_member','guild'),('bystander','g_member','guild'),('limited','g_limited','guild'),('admin','b_mod','bare'),('victim','b_member','bare')", nil},
		{"INSERT INTO channel_permissions(channel_id,role_id,allow,deny) VALUES('v2','g_limited',0,?)", []any{int64(models.PermViewChannel)}},
	}
	for _, statement := range seed {
		if _, err := db.Exec(statement.query, statement.args...); err != nil {
			t.Fatalf("seed %q: %v", statement.query, err)
		}
	}

	// As initRepositories: one querier in front of every repository.
	f.recorder = &voicePGRecorder{db: database.NewRetryingQuerier(db)}
	channels := repository.NewSQLiteChannelRepo(f.recorder)
	reader := channels.VoiceAccess()
	if reader == nil {
		t.Fatal("PostgreSQL did not select the snapshot voice access reader")
	}
	f.access = &voicePGAccess{VoiceAccessReader: reader}
	servers := repository.NewSQLiteServerRepo(f.recorder)
	f.livekit = &voicePGLiveKit{LiveKitStore: repository.NewSQLiteLiveKitRepo(f.recorder)}

	hub := &voicePGHub{online: map[string][]string{
		"guild": {"admin", "victim", "bystander", "limited", "victim", "", "nobody"},
		"bare":  {"admin", "victim"},
	}}
	hub.BroadcastToUserFn = func(userID string, event ws.Event) {
		f.userSends <- moveSnapshotUserEvent{userID, event}
	}
	hub.BroadcastToUsersFn = func(ids []string, event ws.Event) {
		if data, ok := event.Data.(ws.VoiceStateUpdateBroadcast); ok {
			audience := slices.Clone(ids)
			sort.Strings(audience)
			f.published <- voicePGPublication{channelID: data.ChannelID, action: data.Action, audience: audience}
		}
	}
	permissions := NewChannelPermissionService(repository.NewSQLiteChannelPermRepo(f.recorder), repository.NewSQLiteRoleRepo(f.recorder), channels, hub)
	t.Cleanup(permissions.Stop)
	f.perms = &voicePGPermissions{ChannelPermissionRuntime: permissions}

	// As initVoiceRuntimeServices, without the media integrations and the
	// usage workers, which the join and the move do not go through.
	f.svc = NewVoiceService(channels, f.livekit, f.perms, hub, nil, servers, tokenTestEncryptionKey,
		repository.NewSQLiteMemberTimeoutRepo(f.recorder), repository.NewSQLiteBanRepo(f.recorder), nil,
		VoiceRuntimeDependencies{
			Fanout:      VoiceFanoutDependencies{Online: hub, Members: servers},
			VoiceAccess: f.access, FreshPermissions: permissions,
		}).(*voiceService)
	t.Cleanup(f.svc.ShutdownVoiceStateFanout)

	// Wall-clock bounds are pinned by the fake-backed tests; here a slow
	// database must not turn "minted from the move's own read" into a repeat.
	maxSnapshotAge, refreshTimeout := voiceMoveCredentialsMaxSnapshotAge, voiceMoveRefreshTimeout
	voiceMoveCredentialsMaxSnapshotAge, voiceMoveRefreshTimeout = time.Hour, time.Hour
	t.Cleanup(func() {
		voiceMoveCredentialsMaxSnapshotAge, voiceMoveRefreshTimeout = maxSnapshotAge, refreshTimeout
	})
	return f
}

// join places userID in channelID and waits until the fanout has published
// the join, so the statements and publications of the step under test start
// from a quiet worker.
func (f *voicePGFixture) join(t *testing.T, userID, channelID string) {
	t.Helper()
	if err := f.svc.JoinChannel(userID, userID, strings.ToUpper(userID), "", channelID, false, false); err != nil {
		t.Fatalf("join %s into %s: %v", userID, channelID, err)
	}
	if got := f.publication(t); got.channelID != channelID || got.action != "join" {
		t.Fatalf("publication after the join: %+v", got)
	}
}

func (f *voicePGFixture) publication(t *testing.T) voicePGPublication {
	t.Helper()
	select {
	case publication := <-f.published:
		return publication
	case <-time.After(5 * time.Second):
		t.Fatal("no voice state publication")
		return voicePGPublication{}
	}
}

func (f *voicePGFixture) forceMove(t *testing.T, userID string) ws.VoiceForceMoveData {
	t.Helper()
	timeout := time.After(5 * time.Second)
	for {
		select {
		case sent := <-f.userSends:
			if sent.event.Op != ws.OpVoiceForceMove {
				continue
			}
			data, ok := sent.event.Data.(ws.VoiceForceMoveData)
			if !ok || sent.userID != userID {
				t.Fatalf("voice_force_move to %q with %T", sent.userID, sent.event.Data)
			}
			return data
		case <-timeout:
			t.Fatal("no voice_force_move event")
		}
	}
}

// settle waits for the asynchronous source-room evictions of one departure
// from room: the user's identity and its screen-share identity, each after
// its own LiveKit instance lookup. linked says whether the server has an
// instance to remove them from. The schema is dropped when the test ends,
// so nothing may still be reading by then.
func (f *voicePGFixture) settle(t *testing.T, room, userID string, linked bool) {
	t.Helper()
	want := []string{}
	if linked {
		want = []string{room + " " + userID, room + " " + userID + "_ss"}
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		f.mu.Lock()
		got := slices.Clone(f.removed)
		f.mu.Unlock()
		sort.Strings(got)
		lookups := len(f.livekit.lookedUp())
		if lookups >= 2 && len(got) >= len(want) {
			if !slices.Equal(got, want) {
				t.Fatalf("LiveKit removals %v, want %v", got, want)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("evictions did not settle: %d instance lookups, removals %v (want %v)", lookups, got, want)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestPostgresVoiceJoin_SnapshotPathNeedsNoSeparateInstanceLookup(t *testing.T) {
	f := newVoicePGFixture(t)
	f.recorder.take()

	if err := f.svc.JoinChannel("victim", "victim", "VICTIM", "", "v1", false, false); err != nil {
		t.Fatalf("join: %v", err)
	}
	statements := f.recorder.take()
	// One statement carries the channel, the admission and the instance.
	token := voicePGMatching(statements, voicePGTokenRead)
	if len(token) != 1 || !reflect.DeepEqual(token[0].args[:4], []any{"victim", "victim", "victim", "v1"}) {
		t.Fatalf("token reads of the join: %v", token)
	}
	if instance := voicePGMatching(statements, voicePGInstanceTable); len(instance) != 1 {
		t.Fatalf("statements reading livekit_instances during the join: %v", instance)
	}
	if admission := voicePGMatching(statements, voicePGAdmissionRead); len(admission) != 1 {
		// The token read contains the admission read's text; a second match
		// would be the separate admission read.
		t.Fatalf("admission reads of the join: %v", admission)
	}
	if lookups := f.livekit.lookedUp(); len(lookups) != 0 {
		t.Fatalf("separate LiveKit instance lookups during the join: %v", lookups)
	}
	state := f.svc.GetUserVoiceState("victim")
	if state == nil || state.ChannelID != "v1" || state.ServerID != "guild" {
		t.Fatalf("state after the join: %+v", state)
	}
	// The instance the read carried is what the session is attributed to.
	if state.LiveKitInstanceID != "sfu" || state.LiveKitIsCloud {
		t.Fatalf("session attributed to instance %q (cloud=%v), want sfu", state.LiveKitInstanceID, state.LiveKitIsCloud)
	}
	// The join's own fanout runs the visibility statement on these rows.
	joined := f.publication(t)
	if joined.channelID != "v1" || joined.action != "join" || !reflect.DeepEqual(joined.audience, []string{"admin", "bystander", "limited", "victim"}) {
		t.Fatalf("join publication %+v", joined)
	}
	t.Logf("statements inside a fresh JoinChannel: %d %q", len(statements), voicePGSummary(statements))

	// A server without an instance: the token read finds nothing, the plain
	// admission read answers, and the join goes through unattributed.
	if err := f.svc.JoinChannel("admin", "admin", "ADMIN", "", "b1", false, false); err != nil {
		t.Fatalf("join on a server without an instance: %v", err)
	}
	bare := f.recorder.take()
	if token, admission := voicePGMatching(bare, voicePGTokenRead), voicePGMatching(bare, voicePGAdmissionRead); len(token) != 1 || len(admission) != 2 {
		t.Fatalf("reads of the join without an instance: %d token, %d containing the admission text; want the token read and one fallback", len(token), len(admission))
	}
	if lookups := f.livekit.lookedUp(); len(lookups) != 0 {
		t.Fatalf("separate LiveKit instance lookups: %v", lookups)
	}
	if state := f.svc.GetUserVoiceState("admin"); state == nil || state.ChannelID != "b1" || state.ServerID != "bare" || state.LiveKitInstanceID != "" {
		t.Fatalf("state after the join without an instance: %+v", state)
	}
	if joined := f.publication(t); joined.channelID != "b1" || !reflect.DeepEqual(joined.audience, []string{"admin", "victim"}) {
		t.Fatalf("join publication on the server without an instance: %+v", joined)
	}

	// A channel that does not exist is refused, by both reads.
	if err := f.svc.JoinChannel("bystander", "bystander", "BYSTANDER", "", "no-such-channel", false, false); err == nil {
		t.Fatal("join into a missing channel succeeded")
	}
	if f.svc.GetUserVoiceState("bystander") != nil {
		t.Fatal("state written for a missing channel")
	}
}

func TestPostgresVoiceMove_ModeratorMoveEmbedsCredentials(t *testing.T) {
	f := newVoicePGFixture(t)
	f.join(t, "victim", "v1")

	// Park the fanout worker in another server's read, so the move's leave
	// and join are drained as one batch whatever the scheduler does.
	parked, release := make(chan struct{}), make(chan struct{})
	var once, released sync.Once
	letGo := func() { released.Do(func() { close(release) }) }
	// A failed assertion must not leave the worker parked: the fixture's
	// cleanup waits for it.
	defer letGo()
	f.access.mu.Lock()
	f.access.onVisible = func(serverID string) {
		if serverID == "bare" {
			once.Do(func() {
				close(parked)
				<-release
			})
		}
	}
	f.access.mu.Unlock()
	f.svc.voiceFanout.submit("bare", ws.Event{Op: ws.OpVoiceStateUpdate, Data: ws.VoiceStateUpdateBroadcast{ChannelID: "b1", Action: "primer"}})
	select {
	case <-parked:
	case <-time.After(5 * time.Second):
		t.Fatal("fanout worker did not reach the primer's read")
	}
	f.recorder.take()

	if err := f.svc.MoveUser(context.Background(), "admin", "victim", "v2"); err != nil {
		t.Fatalf("MoveUser: %v", err)
	}
	moveStatements := f.recorder.take()
	if state := f.svc.GetUserVoiceState("victim"); state == nil || state.ChannelID != "v2" || state.ServerID != "guild" {
		t.Fatalf("state after the move: %+v", state)
	}

	// One access read for the moved user; no fallback, no instance lookup.
	token := voicePGMatching(moveStatements, voicePGTokenRead)
	if len(token) != 1 || !reflect.DeepEqual(token[0].args[:4], []any{"victim", "victim", "victim", "v2"}) {
		t.Fatalf("token reads of the move: %v", token)
	}
	if admission := voicePGMatching(moveStatements, voicePGAdmissionRead); len(admission) != 1 {
		t.Fatalf("admission reads of the move: %v", admission)
	}

	data := f.forceMove(t, "victim")
	if data.ChannelID != "v2" || data.ServerID != "guild" {
		t.Fatalf("event routing: channel=%q server=%q", data.ChannelID, data.ServerID)
	}
	if data.Voice == nil {
		t.Fatal("voice_force_move carries no credentials")
	}
	var instanceURL string
	if err := f.db.QueryRow("SELECT url FROM livekit_instances WHERE id='sfu'").Scan(&instanceURL); err != nil {
		t.Fatal(err)
	}
	if data.Voice.ChannelID != "v2" || data.Voice.URL != instanceURL {
		t.Fatalf("credentials routing: channel=%q url=%q, want v2 at %q", data.Voice.ChannelID, data.Voice.URL, instanceURL)
	}
	claims := decodeVoiceClaims(t, data.Voice.Token)
	if claims.Identity != "victim" || !claims.Video.RoomJoin || claims.Video.Room != "guild:v2" {
		t.Fatalf("token identity=%q join=%v room=%q", claims.Identity, claims.Video.RoomJoin, claims.Video.Room)
	}
	// The same key material and grant a token request returns for the room.
	requested, err := f.svc.GenerateToken(context.Background(), "victim", "victim", "VICTIM", "guild", "v2")
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if data.Voice.E2EEPassphrase == "" || data.Voice.E2EEPassphrase != requested.E2EEPassphrase || data.Voice.E2EEKeyEpoch != requested.E2EEKeyEpoch {
		t.Fatal("embedded media key differs from a token request's")
	}
	if !reflect.DeepEqual(claims.Video, decodeVoiceClaims(t, requested.Token).Video) {
		t.Fatal("embedded grant differs from a token request's grant")
	}

	// Fanout: one visibility statement for the two channels of the move, and
	// each event to its own channel's audience. limited may not view v2.
	f.recorder.take()
	letGo()
	if primer := f.publication(t); primer.channelID != "b1" || primer.action != "primer" {
		t.Fatalf("first publication %+v, want the primer", primer)
	}
	leave, join := f.publication(t), f.publication(t)
	if leave.channelID != "v1" || leave.action != "leave" || !reflect.DeepEqual(leave.audience, []string{"admin", "bystander", "limited", "victim"}) {
		t.Fatalf("leave publication %+v", leave)
	}
	if join.channelID != "v2" || join.action != "join" || !reflect.DeepEqual(join.audience, []string{"admin", "bystander", "victim"}) {
		t.Fatalf("join publication %+v", join)
	}
	f.settle(t, "guild:v1", "victim", true)
	visibility := voicePGMatching(f.recorder.take(), voicePGVisibilityRead)
	// The primer's own statement, then one for both of the move's channels.
	if len(visibility) != 2 {
		t.Fatalf("%d visibility statements after the move, want the primer's and one for the move: %v", len(visibility), visibility)
	}
	if got := visibility[1].args; len(got) != 4 || got[0] != "guild" || got[2] != "guild" || !reflect.DeepEqual(got[3], []string{"v1", "v2"}) {
		t.Fatalf("the move's visibility statement was bound with %v", got)
	}
	t.Logf("statements inside MoveUser with a cold permission cache: %d %q; visibility statements for its leave and join: 1", len(moveStatements), voicePGSummary(moveStatements))
}

func TestPostgresVoiceMove_ServerWithoutInstanceAppliesWithoutCredentials(t *testing.T) {
	f := newVoicePGFixture(t)
	f.join(t, "victim", "b1")
	f.recorder.take()

	if err := f.svc.MoveUser(context.Background(), "admin", "victim", "b2"); err != nil {
		t.Fatalf("MoveUser on a server without a LiveKit instance: %v", err)
	}
	statements := f.recorder.take()
	if state := f.svc.GetUserVoiceState("victim"); state == nil || state.ChannelID != "b2" || state.ServerID != "bare" {
		t.Fatalf("state after the move: %+v", state)
	}
	// The token read finds no row; the plain admission read decides.
	if token, admission := voicePGMatching(statements, voicePGTokenRead), voicePGMatching(statements, voicePGAdmissionRead); len(token) != 1 || len(admission) != 2 {
		t.Fatalf("reads of the move: %d token, %d containing the admission text; want the token read and one fallback", len(token), len(admission))
	}
	data := f.forceMove(t, "victim")
	if data.Voice != nil {
		t.Fatal("credentials embedded for a server without a LiveKit instance")
	}
	if data.ChannelID != "b2" || data.ServerID != "bare" {
		t.Fatalf("event routing: channel=%q server=%q", data.ChannelID, data.ServerID)
	}
	if got := jsonKeys(t, data); !reflect.DeepEqual(got, []string{"channel_id", "server_id"}) {
		t.Fatalf("event fields without credentials: %v", got)
	}
	leave, join := f.publication(t), f.publication(t)
	if leave.channelID != "b1" || leave.action != "leave" || join.channelID != "b2" || join.action != "join" {
		t.Fatalf("publications %+v %+v", leave, join)
	}
	// The source-room evictions look the instance up, find none and stop.
	f.settle(t, "bare:b1", "victim", false)

	// A missing target channel is still "not found", from the fallback read.
	if err := f.svc.MoveUser(context.Background(), "admin", "victim", "no-such-channel"); err == nil {
		t.Fatal("move into a missing channel succeeded")
	}
	if state := f.svc.GetUserVoiceState("victim"); state == nil || state.ChannelID != "b2" {
		t.Fatalf("state after the refused move: %+v", state)
	}
}

// The repeated access read is a second run of the real statement: a timeout
// committed after the move's own read is in its answer, and the credentials
// stay out.
func TestPostgresVoiceMove_RepeatedReadSeesASanctionCommittedMeanwhile(t *testing.T) {
	// Skip here, not only in each case's fixture: a parent whose cases all
	// skipped would be reported as passed.
	if os.Getenv("HICHAT_TEST_POSTGRES_DSN") == "" {
		t.Skip("requires isolated local PostgreSQL")
	}
	for _, tc := range []struct {
		name     string
		sanction string
		embedded bool
	}{
		{"nothing committed", "", true},
		{"timeout committed", "INSERT INTO member_timeouts(server_id,user_id,expires_at,applied_by) VALUES('guild','victim',CURRENT_TIMESTAMP + INTERVAL '10 minutes','admin')", false},
		{"membership removed", "DELETE FROM server_members WHERE server_id='guild' AND user_id='victim'", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newVoicePGFixture(t)
			f.join(t, "victim", "v1")

			// The snapshot ages past its bound while the mover's permission
			// reads are in flight; the repeated read runs after the sanction.
			var expire sync.Once
			f.perms.mu.Lock()
			f.perms.onResolve = func() { expire.Do(func() { voiceMoveCredentialsMaxSnapshotAge = -1 }) }
			f.perms.mu.Unlock()
			baseline := f.access.tokenReads
			f.access.mu.Lock()
			f.access.onTokenRead = func(read int) {
				if read-baseline == 2 {
					if tc.sanction != "" {
						if _, err := f.db.Exec(tc.sanction); err != nil {
							t.Errorf("commit sanction: %v", err)
						}
					}
					voiceMoveCredentialsMaxSnapshotAge = time.Hour
				}
			}
			f.access.mu.Unlock()
			f.recorder.take()

			if err := f.svc.MoveUser(context.Background(), "admin", "victim", "v2"); err != nil {
				t.Fatalf("MoveUser: %v", err)
			}
			if token := voicePGMatching(f.recorder.take(), voicePGTokenRead); len(token) != 2 {
				t.Fatalf("%d token reads, want the move's and one repeat", len(token))
			}
			if state := f.svc.GetUserVoiceState("victim"); state == nil || state.ChannelID != "v2" {
				t.Fatalf("state after the move: %+v", state)
			}
			data := f.forceMove(t, "victim")
			if (data.Voice != nil) != tc.embedded {
				t.Fatalf("credentials embedded = %v, want %v", data.Voice != nil, tc.embedded)
			}
			f.publication(t)
			f.publication(t)
			f.settle(t, "guild:v1", "victim", true)
		})
	}
}
