package database

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/stdlib"
)

// PostgreSQLPool adapts portable repository bind markers at the driver boundary,
// including statements executed inside sql.Tx. PostgreSQL-specific operations
// (search, JSON mutation, maintenance) remain explicit repository code.
func PostgreSQLPool(cfg *pgx.ConnConfig) *sql.DB {
	cfg = cfg.Copy()
	cfg.RuntimeParams["timezone"] = "UTC"
	return sql.OpenDB(pgConnector{stdlib.GetConnector(*cfg, stdlib.OptionAfterConnect(func(ctx context.Context, conn *pgx.Conn) error {
		conn.TypeMap().RegisterType(&pgtype.Type{Name: "timestamptz", OID: pgtype.TimestamptzOID, Codec: &pgtype.TimestamptzCodec{ScanLocation: time.UTC}})
		return nil
	}))})
}

type pgConnector struct{ driver.Connector }
type pgDriver struct{ driver.Driver }
type pgConn struct{ *stdlib.Conn }
type pgRows struct{ driver.Rows }
type pgStmt struct{ driver.Stmt }

func (s pgStmt) Query(args []driver.Value) (driver.Rows, error) {
	rows, err := s.Stmt.Query(args)
	if err != nil {
		return nil, err
	}
	return pgRows{rows}, nil
}
func (s pgStmt) QueryContext(ctx context.Context, args []driver.NamedValue) (driver.Rows, error) {
	rows, err := s.Stmt.(driver.StmtQueryContext).QueryContext(ctx, args)
	if err != nil {
		return nil, err
	}
	return pgRows{rows}, nil
}
func (s pgStmt) ExecContext(ctx context.Context, args []driver.NamedValue) (driver.Result, error) {
	return s.Stmt.(driver.StmtExecContext).ExecContext(ctx, args)
}

func (r pgRows) Next(values []driver.Value) error {
	err := r.Rows.Next(values)
	if err != nil {
		return err
	}
	// SQLite returns EXISTS and predicates as 0/1. database/sql accepts these
	// for both bool and integer destinations, preserving repository contracts.
	for i, value := range values {
		if b, ok := value.(bool); ok {
			if b {
				values[i] = int64(1)
			} else {
				values[i] = int64(0)
			}
		}
	}
	return nil
}

func (c pgConnector) Driver() driver.Driver { return pgDriver{c.Connector.Driver()} }
func (c pgConnector) Connect(ctx context.Context) (driver.Conn, error) {
	conn, err := c.Connector.Connect(ctx)
	if err != nil {
		return nil, err
	}
	return &pgConn{conn.(*stdlib.Conn)}, nil
}
func (c *pgConn) Prepare(query string) (driver.Stmt, error) {
	return c.PrepareContext(context.Background(), query)
}
func (c *pgConn) PrepareContext(ctx context.Context, query string) (driver.Stmt, error) {
	query, err := postgresQuery(query)
	if err != nil {
		return nil, err
	}
	stmt, err := c.Conn.PrepareContext(ctx, query)
	if err != nil {
		return nil, err
	}
	return pgStmt{stmt}, nil
}
func (c *pgConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	query, err := postgresQuery(query)
	if err != nil {
		return nil, err
	}
	return c.Conn.ExecContext(ctx, query, args)
}
func (c *pgConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	query, err := postgresQuery(query)
	if err != nil {
		return nil, err
	}
	rows, err := c.Conn.QueryContext(ctx, query, args)
	if err != nil {
		return nil, err
	}
	return pgRows{rows}, nil
}
func (c *pgConn) CheckNamedValue(v *driver.NamedValue) error {
	if valuer, ok := v.Value.(driver.Valuer); ok {
		value, err := valuer.Value()
		if err != nil {
			return err
		}
		v.Value = value
	}
	switch value := v.Value.(type) {
	case bool:
		if value {
			v.Value = int64(1)
		} else {
			v.Value = int64(0)
		}
	case *bool:
		if value == nil {
			v.Value = nil
		} else if *value {
			v.Value = int64(1)
		} else {
			v.Value = int64(0)
		}
	}
	return nil
}

func IsPostgres(q TxQuerier) bool {
	if db := RawDB(q); db != nil {
		_, ok := db.Driver().(pgDriver)
		return ok
	}
	return false
}

// bindPostgres understands SQL strings, quoted identifiers and comments. It
// never inserts argument values, and preserves SQLite's repeated ?N binding.
func bindPostgres(query string) (string, error) {
	var out strings.Builder
	next := 0
	for i := 0; i < len(query); {
		c := query[i]
		if c == '\'' || c == '"' || c == '`' {
			quote := c
			out.WriteByte(c)
			i++
			for i < len(query) {
				c = query[i]
				out.WriteByte(c)
				i++
				if c == quote {
					if i < len(query) && query[i] == quote {
						out.WriteByte(query[i])
						i++
						continue
					}
					break
				}
			}
			continue
		}
		if i+1 < len(query) && query[i:i+2] == "--" {
			end := strings.IndexByte(query[i:], '\n')
			if end < 0 {
				out.WriteString(query[i:])
				break
			}
			out.WriteString(query[i : i+end+1])
			i += end + 1
			continue
		}
		if i+1 < len(query) && query[i:i+2] == "/*" {
			end := strings.Index(query[i+2:], "*/")
			if end < 0 {
				return "", fmt.Errorf("unterminated SQL comment")
			}
			end += i + 4
			out.WriteString(query[i:end])
			i = end
			continue
		}
		if c != '?' {
			out.WriteByte(c)
			i++
			continue
		}
		i++
		start := i
		for i < len(query) && query[i] >= '0' && query[i] <= '9' {
			i++
		}
		n := next + 1
		if start < i {
			var err error
			n, err = strconv.Atoi(query[start:i])
			if err != nil || n < 1 {
				return "", fmt.Errorf("invalid bind position")
			}
		}
		if n > next {
			next = n
		}
		fmt.Fprintf(&out, "$%d", n)
	}
	return out.String(), nil
}

var (
	pgIgnore      = regexp.MustCompile(`(?i)\bINSERT\s+OR\s+IGNORE\s+INTO\b`)
	pgReplace     = regexp.MustCompile(`(?i)\bINSERT\s+OR\s+REPLACE\s+INTO\s+(\w+)`)
	pgNow         = regexp.MustCompile(`(?i)datetime\(\s*'now'\s*\)`)
	pgRelativeNow = regexp.MustCompile(`(?i)datetime\(\s*'now'\s*,\s*'([-+0-9 ]+(?:days?|hours?|minutes?|seconds?))'\s*\)`)
	pgEpoch       = regexp.MustCompile(`(?i)CAST\(strftime\('%s',\s*('now'|[\w.]+)\)\s+AS INTEGER\)`)
	pgFormatNow   = regexp.MustCompile(`(?i)strftime\('[^']+',\s*'now'\)`)
	pgGroupConcat = regexp.MustCompile(`(?i)GROUP_CONCAT\(([\w.]+)\)`)
	pgNoCase      = regexp.MustCompile(`(?i)([\w.]+)\s*=\s*(\$\d+)\s+COLLATE NOCASE`)
)

func postgresQuery(query string) (string, error) {
	// Native migrations may start with documentation comments and contain
	// dollar-quoted function bodies. They are not repository SQL to translate.
	head := strings.TrimSpace(query)
	for strings.HasPrefix(head, "--") {
		end := strings.IndexByte(head, '\n')
		if end < 0 {
			return query, nil
		}
		head = strings.TrimSpace(head[end+1:])
	}
	native := strings.ToUpper(head)
	if strings.HasPrefix(native, "CREATE ") || strings.HasPrefix(native, "ALTER ") || strings.HasPrefix(native, "DO $") {
		return query, nil
	}
	q, err := bindPostgres(query)
	if err != nil {
		return "", err
	}
	// Native migration files contain no '?' placeholders. Avoid rewriting DDL.
	upper := strings.ToUpper(strings.TrimSpace(q))
	if strings.HasPrefix(upper, "CREATE ") || strings.HasPrefix(upper, "ALTER ") {
		return q, nil
	}
	q = pgRelativeNow.ReplaceAllString(q, "(CURRENT_TIMESTAMP + INTERVAL '$1')")
	q = pgNow.ReplaceAllString(q, "CURRENT_TIMESTAMP")
	q = pgEpoch.ReplaceAllStringFunc(q, func(s string) string {
		v := pgEpoch.FindStringSubmatch(s)[1]
		if v == "'now'" {
			v = "CURRENT_TIMESTAMP"
		}
		return "CAST(EXTRACT(EPOCH FROM " + v + ") AS BIGINT)"
	})
	q = pgFormatNow.ReplaceAllString(q, "CURRENT_TIMESTAMP")
	q = pgGroupConcat.ReplaceAllString(q, "string_agg($1, ',')")
	q = strings.ReplaceAll(q, "json_object(", "hichat_json_object(")
	q = strings.ReplaceAll(q, "lower(hex(randomblob(8)))", "encode(gen_random_bytes(8), 'hex')")
	q = strings.ReplaceAll(q, "lower(hex(randomblob(16)))", "encode(gen_random_bytes(16), 'hex')")
	q = pgNoCase.ReplaceAllString(q, "hichat_ascii_lower($1) = hichat_ascii_lower($2)")
	q = strings.ReplaceAll(q, "CASE WHEN u.is_platform_banned THEN", "CASE WHEN u.is_platform_banned <> 0 THEN")
	q = strings.ReplaceAll(q, "MAX(server_count - 1, 0)", "GREATEST(server_count - 1, 0)")
	if strings.Contains(q, "channel_group_sessions") {
		q = regexp.MustCompile(`\browid\b`).ReplaceAllString(q, "insertion_order")
	}
	if pgIgnore.MatchString(q) {
		q = pgIgnore.ReplaceAllString(q, "INSERT INTO")
		q = strings.TrimSuffix(strings.TrimSpace(q), ";") + " ON CONFLICT DO NOTHING"
	}
	if m := pgReplace.FindStringSubmatch(q); m != nil {
		clauses := map[string]string{
			"bans":              "(server_id,user_id) DO UPDATE SET username=excluded.username,reason=excluded.reason,banned_by=excluded.banned_by,expires_at=excluded.expires_at,created_at=excluded.created_at",
			"member_timeouts":   "(server_id,user_id) DO UPDATE SET expires_at=excluded.expires_at,applied_by=excluded.applied_by,reason=excluded.reason,created_at=excluded.created_at",
			"runtime_telemetry": "(bucket_at) DO UPDATE SET goroutines=excluded.goroutines,heap_alloc_bytes=excluded.heap_alloc_bytes,online_users=excluded.online_users,db_open_conns=excluded.db_open_conns,db_in_use=excluded.db_in_use,db_idle=excluded.db_idle,db_wait_count=excluded.db_wait_count,ws_dispatch_total=excluded.ws_dispatch_total,ws_rate_limit_drops_total=excluded.ws_rate_limit_drops_total,http_requests=excluded.http_requests,http_5xx=excluded.http_5xx,http_max_latency_ms=excluded.http_max_latency_ms,http_avg_latency_ms=excluded.http_avg_latency_ms",
		}
		clause, ok := clauses[strings.ToLower(m[1])]
		if !ok {
			return "", fmt.Errorf("PostgreSQL upsert has no conflict policy for %s", m[1])
		}
		q = pgReplace.ReplaceAllString(q, "INSERT INTO $1")
		q = strings.TrimSuffix(strings.TrimSpace(q), ";") + " ON CONFLICT " + clause
	}
	return q, nil
}
