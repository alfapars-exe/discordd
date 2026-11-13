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
	matches := func(call *ast.CallExpr, receiver, name string) bool {
		selector, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || selector.Sel.Name != name {
			return false
		}
		identifier, ok := selector.X.(*ast.Ident)
		return ok && identifier.Name == receiver
	}
	var connectionClose, watchCleanup, explicitJoin, poolClose token.Pos
	var watchDefers int
	var ownedContext, bypass bool
	ast.Inspect(file, func(node ast.Node) bool {
		switch value := node.(type) {
		case *ast.DeferStmt:
			if name, ok := value.Call.Fun.(*ast.Ident); ok && name.Name == "stopOwnerWatch" {
				watchCleanup = value.Pos()
				watchDefers++
			}
			if function, ok := value.Call.Fun.(*ast.FuncLit); ok {
				ast.Inspect(function.Body, func(child ast.Node) bool {
					if call, ok := child.(*ast.CallExpr); ok && matches(call, "owner", "Close") {
						connectionClose = value.Pos()
					}
					return true
				})
			}
		case *ast.ExprStmt:
			if call, ok := value.X.(*ast.CallExpr); ok {
				if name, ok := call.Fun.(*ast.Ident); ok && name.Name == "stopOwnerWatch" {
					explicitJoin = value.Pos()
				}
			}
		case *ast.CallExpr:
			if matches(value, "db", "Close") {
				poolClose = value.Pos()
			}
			if matches(value, "database", "WatchBackendOwner") && len(value.Args) > 0 {
				context, ok := value.Args[0].(*ast.Ident)
				ownedContext = ok && context.Name == "watchCtx"
			}
		case *ast.GoStmt:
			if matches(value.Call, "database", "WatchBackendOwner") {
				bypass = true
			}
		}
		return true
	})
	if !connectionClose.IsValid() || watchDefers != 1 || watchCleanup < connectionClose {
		t.Fatal("main must register watch cleanup after connection close so LIFO joins watch first")
	}
	if !explicitJoin.IsValid() || !poolClose.IsValid() || explicitJoin > poolClose {
		t.Fatal("ownership watch must join before the database pool closes")
	}
	if !ownedContext || bypass {
		t.Fatal("ownership observer bypasses its owned child context")
	}
}
