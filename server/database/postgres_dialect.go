package database

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"fmt"
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
	queryer, ok := s.Stmt.(driver.StmtQueryContext)
	if !ok {
		return nil, fmt.Errorf("PostgreSQL driver statement does not support contextual queries")
	}
	namedArgs := make([]driver.NamedValue, len(args))
	for i, arg := range args {
		namedArgs[i] = driver.NamedValue{Ordinal: i + 1, Value: arg}
	}
	rows, err := queryer.QueryContext(context.Background(), namedArgs)
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
		switch {
		case value == nil:
			v.Value = nil
		case *value:
			v.Value = int64(1)
		default:
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
	return bindPostgres(query)
}
