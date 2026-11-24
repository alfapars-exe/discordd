package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"log"
	"log/slog"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/ws"
)

// A pooled connection closed for sitting idle costs the next request a new
// remote handshake; the minute line must show those closes as a delta.
func TestRuntimeStatsLogsIdleTimeClosedDelta(t *testing.T) {
	pool := sql.OpenDB(runtimeStatsConnector{})
	t.Cleanup(func() { _ = pool.Close() })
	pool.SetConnMaxIdleTime(time.Hour)
	if err := pool.Ping(); err != nil {
		t.Fatal(err)
	}

	deltas := make(chan int64, 256)
	// SetDefault also points the standard logger at the handler and does not
	// undo that when the original default is put back.
	previous, stdOutput, stdFlags := slog.Default(), log.Writer(), log.Flags()
	// Registered first, so it runs after the restore below: the capture
	// handler drops everything but the stats line and must not stay behind
	// as the standard logger's output for the rest of the test binary.
	t.Cleanup(func() {
		if log.Writer() != stdOutput || log.Flags() != stdFlags {
			t.Errorf("standard logger left on the capture handler: writer %T, flags %d (was %T, %d)", log.Writer(), log.Flags(), stdOutput, stdFlags)
		}
	})
	slog.SetDefault(slog.New(runtimeStatsCapture{deltas: deltas}))
	t.Cleanup(func() {
		slog.SetDefault(previous)
		log.SetOutput(stdOutput)
		log.SetFlags(stdFlags)
	})

	stop := startRuntimeStatsLogger(ws.NewHub(), &database.DB{Conn: pool}, 10*time.Millisecond, nil, nil, 0)
	t.Cleanup(stop)
	next := func() int64 {
		t.Helper()
		select {
		case delta := <-deltas:
			return delta
		case <-time.After(10 * time.Second):
			t.Fatal("runtime stats line was not logged")
			return 0
		}
	}
	// The first line proves the logger took its baseline before the close.
	if delta := next(); delta != 0 {
		t.Fatalf("idle-time closes before any close: %d", delta)
	}
	// Shortening the limit wakes the pool's cleaner, which closes the
	// connection that has been idle since the Ping above.
	pool.SetConnMaxIdleTime(time.Millisecond)
	deadline := time.Now().Add(10 * time.Second)
	for pool.Stats().MaxIdleTimeClosed != 1 {
		if time.Now().After(deadline) {
			t.Fatalf("pool did not close the idle connection: %+v", pool.Stats())
		}
		time.Sleep(time.Millisecond)
	}
	for {
		delta := next()
		if delta == 1 {
			break
		}
		if delta != 0 || time.Now().After(deadline) {
			t.Fatalf("idle-time closed delta = %d, want 1", delta)
		}
	}
	if delta := next(); delta != 0 {
		t.Fatalf("idle-time close reported again as %d; the value must be a per-interval delta", delta)
	}
}

// runtimeStatsCapture reports the idle-time-closed delta of each runtime stats
// line, or -1 when the line does not carry it.
type runtimeStatsCapture struct{ deltas chan<- int64 }

func (runtimeStatsCapture) Enabled(context.Context, slog.Level) bool { return true }
func (h runtimeStatsCapture) Handle(_ context.Context, record slog.Record) error {
	if record.Message != "runtime stats" {
		return nil
	}
	delta := int64(-1)
	record.Attrs(func(attr slog.Attr) bool {
		if attr.Key != "db_max_idle_time_closed_delta" {
			return true
		}
		delta = attr.Value.Int64()
		return false
	})
	select {
	case h.deltas <- delta:
	default:
	}
	return nil
}
func (h runtimeStatsCapture) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h runtimeStatsCapture) WithGroup(string) slog.Handler      { return h }

type runtimeStatsConnector struct{}

func (runtimeStatsConnector) Connect(context.Context) (driver.Conn, error) {
	return &runtimeStatsConn{}, nil
}
func (runtimeStatsConnector) Driver() driver.Driver { return runtimeStatsDriver{} }

type runtimeStatsDriver struct{}

func (runtimeStatsDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("unexpected direct driver Open")
}

type runtimeStatsConn struct{}

func (*runtimeStatsConn) Close() error { return nil }
func (*runtimeStatsConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("unexpected statement on runtime stats fixture")
}
func (*runtimeStatsConn) Begin() (driver.Tx, error) {
	return nil, errors.New("unexpected transaction on runtime stats fixture")
}
