package database

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"sync/atomic"
	"testing"
	"time"
)

// The watcher's slack is only safe while a full probe cycle stays well inside
// the time after which the server (or a booting instance) may end an idle
// owner session. See the comment on backendOwnerProbeTimeout.
func TestBackendOwnerProbeBudget(t *testing.T) {
	worst := backendOwnerProbeTimeout + backendOwnerProbeInterval + backendOwnerProbeTimeout
	if worst > backendOwnerIdleTimeout/2 {
		t.Fatalf("worst-case loss detection %s exceeds half of the %s owner idle limit", worst, backendOwnerIdleTimeout)
	}
	if backendOwnerIdleTimeout > staleBackendOwnerAfter {
		t.Fatalf("owner idle limit %s is no longer the earliest takeover (stale after %s)", backendOwnerIdleTimeout, staleBackendOwnerAfter)
	}
}

// A probe slower than the previous 2s deadline must not cost ownership as long
// as it answers "owned" inside backendOwnerProbeTimeout.
func TestWatchBackendOwnerToleratesBriefStall(t *testing.T) {
	if testing.Short() {
		t.Skip("waits for a real probe interval and a stalled probe")
	}
	var probes atomic.Int32
	answered := make(chan struct{}, 4)
	conn := ownerProbeConn(t, func(ctx context.Context) (bool, error) {
		if probes.Add(1) == 1 {
			select {
			case <-time.After(2500 * time.Millisecond):
			case <-ctx.Done():
				return false, ctx.Err()
			}
		}
		answered <- struct{}{}
		return true, nil
	})
	ctx, cancel := context.WithCancel(context.Background())
	var lost atomic.Bool
	done := make(chan struct{})
	go func() {
		defer close(done)
		WatchBackendOwner(ctx, conn, func() { lost.Store(true) })
	}()
	for i := 0; i < 2; i++ {
		select {
		case <-answered:
		case <-done:
			t.Fatalf("watch ended after %d probes; lost=%v", probes.Load(), lost.Load())
		case <-time.After(15 * time.Second):
			t.Fatal("probe did not answer")
		}
	}
	cancel()
	<-done
	if lost.Load() {
		t.Fatal("stall shorter than the probe deadline reported ownership loss")
	}
}

func TestWatchBackendOwnerKeepsWatchingWhileOwned(t *testing.T) {
	var probes atomic.Int32
	answered := make(chan struct{}, 8)
	conn := ownerProbeConn(t, func(ctx context.Context) (bool, error) {
		probes.Add(1)
		// Slower than the interval, well inside the deadline.
		select {
		case <-time.After(20 * time.Millisecond):
		case <-ctx.Done():
			return false, ctx.Err()
		}
		select {
		case answered <- struct{}{}:
		default:
		}
		return true, nil
	})
	ctx, cancel := context.WithCancel(context.Background())
	var lost atomic.Bool
	done := make(chan struct{})
	go func() {
		defer close(done)
		watchBackendOwner(ctx, conn, 5*time.Millisecond, 10*time.Second, func() { lost.Store(true) })
	}()
	for i := 0; i < 3; i++ {
		select {
		case <-answered:
		case <-done:
			t.Fatalf("watch ended after %d probes; lost=%v", probes.Load(), lost.Load())
		case <-time.After(10 * time.Second):
			t.Fatal("probe did not answer")
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("cancelled watch did not return")
	}
	if lost.Load() {
		t.Fatal("slow but successful probes reported ownership loss")
	}
}

// Every outcome other than "owned" ends the watch on the first probe: there is
// no retry after a definite answer, an error, or a missed deadline.
func TestWatchBackendOwnerFailsClosedWithoutRetry(t *testing.T) {
	for _, tc := range []struct {
		name    string
		timeout time.Duration
		probe   func(context.Context) (bool, error)
	}{
		{"not_owned", 10 * time.Second, func(context.Context) (bool, error) { return false, nil }},
		{"connection_error", 10 * time.Second, func(context.Context) (bool, error) { return false, driver.ErrBadConn }},
		{"query_error", 10 * time.Second, func(context.Context) (bool, error) { return false, errors.New("injected probe failure") }},
		{"deadline", 50 * time.Millisecond, func(ctx context.Context) (bool, error) { <-ctx.Done(); return false, ctx.Err() }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var probes, lost atomic.Int32
			conn := ownerProbeConn(t, func(ctx context.Context) (bool, error) {
				probes.Add(1)
				return tc.probe(ctx)
			})
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan struct{})
			started := time.Now()
			go func() {
				defer close(done)
				watchBackendOwner(ctx, conn, 5*time.Millisecond, tc.timeout, func() { lost.Add(1) })
			}()
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Fatal("watch kept running after a failed probe")
			}
			if lost.Load() != 1 {
				t.Fatalf("onLost calls = %d, want 1", lost.Load())
			}
			// database/sql may re-run a query on a fresh connection after
			// ErrBadConn, but *sql.Conn is pinned to one session and must not.
			if probes.Load() != 1 {
				t.Fatalf("probes = %d, want 1 (no retry)", probes.Load())
			}
			if tc.name == "deadline" && time.Since(started) < tc.timeout {
				t.Fatalf("deadline case ended after %s, before the %s probe deadline", time.Since(started), tc.timeout)
			}
		})
	}
}

func TestWatchBackendOwnerShutdownDuringProbeIsNotLoss(t *testing.T) {
	inProbe := make(chan struct{})
	conn := ownerProbeConn(t, func(ctx context.Context) (bool, error) {
		close(inProbe)
		<-ctx.Done()
		return false, ctx.Err()
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var lost atomic.Bool
	done := make(chan struct{})
	go func() {
		defer close(done)
		watchBackendOwner(ctx, conn, 5*time.Millisecond, 10*time.Second, func() { lost.Store(true) })
	}()
	select {
	case <-inProbe:
	case <-time.After(5 * time.Second):
		t.Fatal("watch did not probe")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("cancelled watch waited for the probe deadline")
	}
	if lost.Load() {
		t.Fatal("shutdown reported ownership loss")
	}
}

// ownerProbeConn returns a dedicated session whose only statement is the
// ownership probe, answered by probe.
func ownerProbeConn(t *testing.T, probe func(context.Context) (bool, error)) *sql.Conn {
	t.Helper()
	pool := sql.OpenDB(ownerProbeConnector{probe: probe})
	t.Cleanup(func() { _ = pool.Close() })
	conn, err := pool.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

type ownerProbeConnector struct {
	probe func(context.Context) (bool, error)
}

func (c ownerProbeConnector) Connect(context.Context) (driver.Conn, error) {
	return &ownerProbeSession{probe: c.probe}, nil
}
func (ownerProbeConnector) Driver() driver.Driver { return ownerProbeDriver{} }

type ownerProbeDriver struct{}

func (ownerProbeDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("unexpected direct driver Open")
}

type ownerProbeSession struct {
	probe func(context.Context) (bool, error)
}

func (s *ownerProbeSession) QueryContext(ctx context.Context, _ string, _ []driver.NamedValue) (driver.Rows, error) {
	owned, err := s.probe(ctx)
	if err != nil {
		return nil, err
	}
	return &ownerProbeRows{owned: owned}, nil
}
func (*ownerProbeSession) Close() error { return nil }
func (*ownerProbeSession) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("unexpected prepared statement on owner session")
}
func (*ownerProbeSession) Begin() (driver.Tx, error) {
	return nil, errors.New("unexpected transaction on owner session")
}

type ownerProbeRows struct {
	owned bool
	read  bool
}

func (*ownerProbeRows) Columns() []string { return []string{"exists"} }
func (*ownerProbeRows) Close() error      { return nil }
func (r *ownerProbeRows) Next(dest []driver.Value) error {
	if r.read {
		return io.EOF
	}
	r.read, dest[0] = true, r.owned
	return nil
}
