package main

import (
	"context"
	"go/ast"
	"go/parser"
	"go/token"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestBackendOwnerWatchNaturalCompletionReleasesContext(t *testing.T) {
	parent, cancelParent := context.WithCancel(context.Background())
	defer cancelParent()
	observed := make(chan context.Context, 1)
	stop := startBackendOwnerWatch(parent, func(ctx context.Context) { observed <- ctx })
	t.Cleanup(stop)
	var ctx context.Context
	select {
	case ctx = <-observed:
	case <-time.After(time.Second):
		t.Fatal("watch did not start")
	}
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("completed watch retained its child context until explicit stop")
	}
	if parent.Err() != nil {
		t.Fatal("natural completion cancelled the caller context")
	}
	stop()
	stop()
}

func TestBackendOwnerWatchStopCancelsAndJoinsBeforeConnectionClose(t *testing.T) {
	parent, cancelParent := context.WithCancel(context.Background())
	started, cancelled, release, exited := make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	stop := startBackendOwnerWatch(parent, func(ctx context.Context) {
		close(started)
		<-ctx.Done()
		close(cancelled)
		<-release
		close(exited)
	})
	t.Cleanup(func() { cancelParent(); releaseOnce.Do(func() { close(release) }); stop() })
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("watch did not start")
	}
	stopped := make(chan struct{})
	go func() { stop(); close(stopped) }()
	select {
	case <-cancelled:
	case <-stopped:
		t.Fatal("cleanup returned without cancelling ownership watch")
	case <-time.After(time.Second):
		t.Fatal("watch context was not cancelled")
	}
	if parent.Err() != nil {
		t.Fatal("watch cleanup cancelled its caller context")
	}
	select {
	case <-stopped:
		t.Fatal("cleanup returned before watch completion; connection could close too early")
	default:
	}
	releaseOnce.Do(func() { close(release) })
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("cleanup did not join the completed watch")
	}
	select {
	case <-exited:
	default:
		t.Fatal("watch remains active after cleanup")
	}
}

func TestBackendOwnerWatchSupportsConcurrentCleanup(t *testing.T) {
	parent, cancelParent := context.WithCancel(context.Background())
	defer cancelParent()
	var calls atomic.Int32
	stoppedWatch := make(chan struct{})
	stop := startBackendOwnerWatch(parent, func(ctx context.Context) { calls.Add(1); <-ctx.Done(); close(stoppedWatch) })
	t.Cleanup(func() { cancelParent(); stop() })
	var owners sync.WaitGroup
	owners.Add(16)
	for i := 0; i < 16; i++ {
		go func() { defer owners.Done(); stop() }()
	}
	owners.Wait()
	select {
	case <-stoppedWatch:
	default:
		t.Fatal("concurrent cleanup did not wait for ownership watch")
	}
	if calls.Load() != 1 {
		t.Fatalf("watch started %d times", calls.Load())
	}
	if parent.Err() != nil {
		t.Fatal("cleanup cancelled shared parent context")
	}
	stop()
}

func TestBackendOwnerWatchParentCancellationPropagates(t *testing.T) {
	parent, cancel := context.WithCancel(context.Background())
	exited := make(chan struct{})
	stop := startBackendOwnerWatch(parent, func(ctx context.Context) { <-ctx.Done(); close(exited) })
	t.Cleanup(func() { cancel(); stop() })
	cancel()
	select {
	case <-exited:
	case <-time.After(time.Second):
		t.Fatal("parent cancellation did not reach watch")
	}
	stop()
}

func TestMainDefersWatchJoinBeforeOwnershipConnectionClose(t *testing.T) {
	file, err := parser.ParseFile(token.NewFileSet(), "main.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	layout := inspectOwnerWatchLayout(file)
	if !layout.connectionClose.IsValid() || layout.watchDefers != 1 || layout.watchCleanup < layout.connectionClose {
		t.Fatal("main must register watch cleanup after connection close so LIFO joins watch first")
	}
	if !layout.explicitJoin.IsValid() || !layout.poolClose.IsValid() || layout.explicitJoin > layout.poolClose {
		t.Fatal("ownership watch must join before the database pool closes")
	}
	if !layout.ownedContext || layout.directStart {
		t.Fatal("ownership observer bypasses its owned child context")
	}
}

type ownerWatchLayout struct {
	connectionClose, watchCleanup, explicitJoin, poolClose token.Pos
	watchDefers                                            int
	ownedContext, directStart                              bool
}

func ownerWatchCallMatches(call *ast.CallExpr, receiver, name string) bool {
	selector, ok := call.Fun.(*ast.SelectorExpr)
	if !ok || selector.Sel.Name != name {
		return false
	}
	identifier, ok := selector.X.(*ast.Ident)
	return ok && identifier.Name == receiver
}

func inspectOwnerWatchLayout(file *ast.File) ownerWatchLayout {
	var layout ownerWatchLayout
	ast.Inspect(file, func(node ast.Node) bool {
		switch value := node.(type) {
		case *ast.DeferStmt:
			layout.observeDefer(value)
		case *ast.ExprStmt:
			layout.observeExpression(value)
		case *ast.CallExpr:
			layout.observeCall(value)
		case *ast.GoStmt:
			layout.directStart = layout.directStart || ownerWatchCallMatches(value.Call, "database", "WatchBackendOwner")
		}
		return true
	})
	return layout
}

func (layout *ownerWatchLayout) observeDefer(statement *ast.DeferStmt) {
	if name, ok := statement.Call.Fun.(*ast.Ident); ok && name.Name == "stopOwnerWatch" {
		layout.watchCleanup = statement.Pos()
		layout.watchDefers++
	}
	function, ok := statement.Call.Fun.(*ast.FuncLit)
	if !ok {
		return
	}
	ast.Inspect(function.Body, func(child ast.Node) bool {
		if call, ok := child.(*ast.CallExpr); ok && ownerWatchCallMatches(call, "owner", "Close") {
			layout.connectionClose = statement.Pos()
		}
		return true
	})
}

func (layout *ownerWatchLayout) observeExpression(statement *ast.ExprStmt) {
	call, ok := statement.X.(*ast.CallExpr)
	if !ok {
		return
	}
	if name, ok := call.Fun.(*ast.Ident); ok && name.Name == "stopOwnerWatch" {
		layout.explicitJoin = statement.Pos()
	}
}

func (layout *ownerWatchLayout) observeCall(call *ast.CallExpr) {
	if ownerWatchCallMatches(call, "db", "Close") {
		layout.poolClose = call.Pos()
	}
	if !ownerWatchCallMatches(call, "database", "WatchBackendOwner") || len(call.Args) == 0 {
		return
	}
	argument, ok := call.Args[0].(*ast.Ident)
	layout.ownedContext = ok && argument.Name == "watchCtx"
}
