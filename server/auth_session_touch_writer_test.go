package main

import (
	"context"
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"log"
	"log/slog"
	"reflect"
	"testing"
	"testing/synctest"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
)

func sessionTouch(sessionID string, at int64) repository.AuthSessionTouch {
	return repository.AuthSessionTouch{UserID: "owner", SessionID: sessionID, At: at}
}

func TestAuthSessionTouchWriterCoalescesBySessionKeepingLatest(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		release := make(chan struct{})
		var written []repository.AuthSessionTouch
		w := newAuthSessionTouchWriter(func(ctx context.Context, touch repository.AuthSessionTouch) {
			deadline, ok := ctx.Deadline()
			if !ok || time.Until(deadline) != authSessionTouchBudget {
				t.Error("touch must run on the writer's own five-second budget")
			}
			<-release
			written = append(written, touch)
		})
		t.Cleanup(w.stop)
		if !w.enqueue(sessionTouch("a", 100)) {
			t.Fatal("first touch rejected")
		}
		synctest.Wait()
		// "a" is in flight now; later touches for it share one pending slot.
		for _, at := range []int64{160, 220, 190} {
			if !w.enqueue(sessionTouch("a", at)) {
				t.Fatalf("coalesced touch at %d rejected", at)
			}
		}
		if !w.enqueue(sessionTouch("b", 130)) {
			t.Fatal("touch for another session rejected")
		}
		if len(w.queue) != 2 {
			t.Fatalf("queued %d writes, want one per waiting session", len(w.queue))
		}
		close(release)
		w.stop()
		want := []repository.AuthSessionTouch{sessionTouch("a", 100), sessionTouch("a", 220), sessionTouch("b", 130)}
		if !reflect.DeepEqual(written, want) {
			t.Fatalf("written %+v, want %+v", written, want)
		}
	})
}

func TestAuthSessionTouchWriterOverflowIsNonBlockingAndDrainsFIFO(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		release := make(chan struct{})
		var written []repository.AuthSessionTouch
		w := newAuthSessionTouchWriter(func(_ context.Context, touch repository.AuthSessionTouch) {
			<-release
			written = append(written, touch)
		})
		t.Cleanup(w.stop)
		if !w.enqueue(sessionTouch("active", 1)) {
			t.Fatal("first touch rejected")
		}
		synctest.Wait()
		for i := range authSessionTouchQueueSize {
			if !w.enqueue(sessionTouch(fmt.Sprint(i), 1)) {
				t.Fatalf("queue rejected session %d before capacity", i)
			}
		}
		for i := range 10 {
			if w.enqueue(sessionTouch(fmt.Sprint("overflow-", i), 1)) {
				t.Fatal("overflow was admitted")
			}
		}
		if w.dropped.Load() != 10 {
			t.Fatal("overflow should aggregate its dropped count")
		}
		// A waiting session needs no new slot, so it still coalesces when full.
		if !w.enqueue(sessionTouch("0", 2)) {
			t.Fatal("full queue rejected a touch for a waiting session")
		}
		close(release)
		w.stop()
		if len(written) != authSessionTouchQueueSize+1 || written[0].SessionID != "active" {
			t.Fatalf("drained %d touches, want %d", len(written), authSessionTouchQueueSize+1)
		}
		if written[1] != sessionTouch("0", 2) {
			t.Fatalf("coalesced touch %+v lost its latest timestamp", written[1])
		}
		for i := range authSessionTouchQueueSize {
			if written[i+1].SessionID != fmt.Sprint(i) {
				t.Fatalf("FIFO item %d: %+v", i, written[i+1])
			}
		}
		if w.enqueue(sessionTouch("stopped", 1)) {
			t.Fatal("stopped writer admitted more work")
		}
		w.stop()
	})
}

func TestAuthSessionTouchWriterStopBoundsDrainAndJoinsCanceledWork(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var started []string
		var completed []error
		w := newAuthSessionTouchWriter(func(ctx context.Context, touch repository.AuthSessionTouch) {
			started = append(started, touch.SessionID)
			<-ctx.Done()
			completed = append(completed, ctx.Err())
		})
		t.Cleanup(w.stop)
		w.enqueue(sessionTouch("first", 1))
		synctest.Wait()
		w.enqueue(sessionTouch("second", 1))
		w.enqueue(sessionTouch("discarded", 1))
		// The first write expires during drain; the second must inherit worker
		// cancellation when the whole drain budget expires one second later.
		time.Sleep(time.Second)
		start := time.Now()
		w.stop()
		if elapsed := time.Since(start); elapsed != authSessionTouchBudget {
			t.Fatalf("shutdown took %s, want %s", elapsed, authSessionTouchBudget)
		}
		if len(started) != 2 || len(completed) != 2 {
			t.Fatalf("shutdown did not join active work/discard pending work: started=%v completed=%v", started, completed)
		}
		if !errors.Is(completed[0], context.DeadlineExceeded) || !errors.Is(completed[1], context.Canceled) {
			t.Fatalf("task and shutdown cancellation=%v", completed)
		}
		select {
		case <-w.done:
		default:
			t.Fatal("shutdown returned before worker exit")
		}
	})
}

func TestAuthSessionTouchWriterPanicDoesNotStrandFollowingTouches(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var completed int
		w := newAuthSessionTouchWriter(func(_ context.Context, touch repository.AuthSessionTouch) {
			if touch.SessionID == "panic" {
				panic("fixture failure")
			}
			completed++
		})
		t.Cleanup(w.stop)
		w.enqueue(sessionTouch("panic", 1))
		w.enqueue(sessionTouch("next", 1))
		w.stop()
		if completed != 1 {
			t.Fatal("panic stranded subsequent touch")
		}
	})
}

// The installed store must answer from the read alone and leave the write to
// the writer: drained by stop, and never run inline once the writer is gone.
func TestInstallAuthSessionTouchWriterDefersAndDrainsSessionActivity(t *testing.T) {
	db, _ := newCensusDB(t)
	repos := initRepositories(db.Conn, repository.DataExportStorageOptions{UploadDir: t.TempDir(), ArchiveDir: t.TempDir()})
	stop := installAuthSessionTouchWriter(db.Conn, repos)
	t.Cleanup(stop)
	ctx := context.Background()
	user := &models.User{Username: "touch_fixture", PasswordHash: "hash", Status: models.UserStatusOnline}
	if err := repos.User.Create(ctx, user); err != nil {
		t.Fatal(err)
	}
	created := time.Now()
	session := &models.AuthSession{ID: "touch-session", UserID: user.ID, ClientType: "web", CreatedAt: created.Unix(), LastActiveAt: created.Unix(), ExpiresAt: created.Add(time.Hour).Unix()}
	refresh := &models.Session{UserID: user.ID, RefreshToken: "touch-refresh", ExpiresAt: created.Add(time.Hour)}
	if err := repos.AuthSession.CreateWithRefresh(ctx, session, refresh); err != nil {
		t.Fatal(err)
	}
	age := func() {
		t.Helper()
		if _, err := db.Conn.Exec(`UPDATE auth_sessions SET last_active_at=1 WHERE id=?`, session.ID); err != nil {
			t.Fatal(err)
		}
	}
	stored := func() (at int64) {
		t.Helper()
		if err := db.Conn.QueryRow(`SELECT last_active_at FROM auth_sessions WHERE id=?`, session.ID).Scan(&at); err != nil {
			t.Fatal(err)
		}
		return at
	}

	age()
	now := time.Now().Unix()
	active, err := repos.AuthSession.GetActive(ctx, user.ID, session.ID, now)
	if err != nil || active.LastActiveAt != now {
		t.Fatalf("queued touch not reported on the validated session: %+v %v", active, err)
	}
	stop()
	if at := stored(); at != now {
		t.Fatalf("shutdown left last_active_at=%d, want drained touch %d", at, now)
	}

	// The stopped writer refuses the touch. That loses the write (below), not
	// the activity this read observed on the returned row.
	age()
	active, err = repos.AuthSession.GetActive(ctx, user.ID, session.ID, now)
	if err != nil || active.LastActiveAt != now {
		t.Fatalf("refused touch hid the activity the read observed: %+v %v", active, err)
	}
	if at := stored(); at != 1 {
		t.Fatalf("session read wrote last_active_at=%d inline", at)
	}
}

// Services capture the session store at construction, and HTTP requests keep
// queueing touches until the server has drained.
func TestAuthSessionTouchWriterInstalledBeforeServicesAndDrainedBeforeDBClose(t *testing.T) {
	file, err := parser.ParseFile(token.NewFileSet(), "main.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	var body *ast.BlockStmt
	for _, decl := range file.Decls {
		if fn, ok := decl.(*ast.FuncDecl); ok && fn.Name.Name == "main" {
			body = fn.Body
		}
	}
	if body == nil {
		t.Fatal("main missing")
	}
	var install, services, drain, closeDB token.Pos
	ast.Inspect(body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		switch fun := call.Fun.(type) {
		case *ast.Ident:
			switch fun.Name {
			case "installAuthSessionTouchWriter":
				install = call.Pos()
			case "initServices":
				services = call.Pos()
			}
		case *ast.SelectorExpr:
			if receiver, ok := fun.X.(*ast.Ident); ok {
				switch receiver.Name + "." + fun.Sel.Name {
				case "srv.Shutdown":
					drain = call.Pos()
				case "db.Close":
					closeDB = call.Pos()
				}
			}
		}
		return true
	})
	// Only the unconditional top-level call counts, not the deferred fallback.
	var stop token.Pos
	for _, stmt := range body.List {
		if expr, ok := stmt.(*ast.ExprStmt); ok {
			if call, ok := expr.X.(*ast.CallExpr); ok {
				if name, ok := call.Fun.(*ast.Ident); ok && name.Name == "stopSessionTouches" {
					stop = stmt.Pos()
				}
			}
		}
	}
	if !install.IsValid() || !services.IsValid() || install > services {
		t.Fatal("session touch writer must be installed before initServices captures the session store")
	}
	if !drain.IsValid() || !closeDB.IsValid() || !stop.IsValid() || stop < drain || stop > closeDB {
		t.Fatal("session touch writer must drain after the HTTP drain and before the database closes")
	}
}

// droppedTouchReports records the level and count of each dropped-touch report.
type droppedTouchReports struct{ lines *[]string }

func (droppedTouchReports) Enabled(context.Context, slog.Level) bool { return true }
func (h droppedTouchReports) Handle(_ context.Context, record slog.Record) error {
	if record.Message != "auth session touches dropped" {
		return nil
	}
	record.Attrs(func(attr slog.Attr) bool {
		if attr.Key == "count" {
			*h.lines = append(*h.lines, fmt.Sprintf("%s count=%d", record.Level, attr.Value.Uint64()))
		}
		return true
	})
	return nil
}
func (h droppedTouchReports) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h droppedTouchReports) WithGroup(string) slog.Handler      { return h }

// Dropped touches are the only sign that the queue overflowed. The report
// must be visible at the default log level, once per batch of drops.
func TestAuthSessionTouchWriterReportsDroppedTouchesAtInfo(t *testing.T) {
	var lines []string
	// SetDefault also points the standard logger at the handler and does not
	// undo that when the original default is put back.
	previous, stdOutput, stdFlags := slog.Default(), log.Writer(), log.Flags()
	slog.SetDefault(slog.New(droppedTouchReports{lines: &lines}))
	t.Cleanup(func() {
		slog.SetDefault(previous)
		log.SetOutput(stdOutput)
		log.SetFlags(stdFlags)
	})

	w := &authSessionTouchWriter{}
	w.reportDropped()
	if len(lines) != 0 {
		t.Fatalf("reported without a dropped touch: %v", lines)
	}
	w.dropped.Add(7)
	w.reportDropped()
	w.reportDropped()
	if want := []string{"INFO count=7"}; !reflect.DeepEqual(lines, want) {
		t.Fatalf("dropped-touch reports: %v, want %v", lines, want)
	}
}
