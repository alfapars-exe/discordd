package database

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"sync/atomic"
	"testing"
	"testing/fstest"
)

// A failed Ping must close a connection already opened by the constructor,
// rather than merely returning a non-nil error or testing an already closed DB.
func TestInitializationPingFailureClosesOpenedConnection(t *testing.T) {
	failure := errors.New("injected startup ping failure")
	connector := &initializationPingConnector{failure: failure}
	pool := sql.OpenDB(connector)
	t.Cleanup(func() { _ = pool.Close() })
	initialized, err := initializeSQLite(pool, fstest.MapFS{})
	if initialized != nil || !errors.Is(err, failure) {
		t.Fatalf("initialization result: %v, %v", initialized, err)
	}
	if opened, closed := connector.opened.Load(), connector.closed.Load(); opened != 1 || closed != opened {
		t.Fatalf("opened=%d closed=%d; failed startup leaked its owned connection", opened, closed)
	}
	if n := pool.Stats().OpenConnections; n != 0 {
		t.Fatalf("open connections after startup failure: %d", n)
	}
	if err := pool.Ping(); err == nil {
		t.Fatal("failed startup returned a reusable pool")
	}
	if n := connector.opened.Load(); n != 1 {
		t.Fatalf("failed startup pool reconnected: %d", n)
	}
}

type initializationPingConnector struct {
	failure error
	opened  atomic.Int32
	closed  atomic.Int32
}

func (c *initializationPingConnector) Connect(context.Context) (driver.Conn, error) {
	c.opened.Add(1)
	return &initializationPingConn{owner: c}, nil
}
func (c *initializationPingConnector) Driver() driver.Driver { return initializationPingDriver{} }

type initializationPingDriver struct{}

func (initializationPingDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("unexpected direct driver Open")
}

type initializationPingConn struct{ owner *initializationPingConnector }

func (c *initializationPingConn) Ping(context.Context) error { return c.owner.failure }
func (c *initializationPingConn) Close() error               { c.owner.closed.Add(1); return nil }
func (*initializationPingConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("unexpected statement after failed startup Ping")
}
func (*initializationPingConn) Begin() (driver.Tx, error) {
	return nil, errors.New("unexpected transaction after failed startup Ping")
}
