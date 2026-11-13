package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"testing"
)

func voiceUsageMainBody(t *testing.T) *ast.BlockStmt {
	t.Helper()
	file, err := parser.ParseFile(token.NewFileSet(), "main.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if ok && fn.Name.Name == "main" {
			return fn.Body
		}
	}
	t.Fatal("main missing")
	return nil
}
func voiceUsageNamedCall(call *ast.CallExpr, name string) bool {
	identifier, ok := call.Fun.(*ast.Ident)
	return ok && identifier.Name == name
}
func voiceUsageMethodCall(call *ast.CallExpr, receiver, name string) bool {
	selector, ok := call.Fun.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	identifier, ok := selector.X.(*ast.Ident)
	return ok && identifier.Name == receiver && selector.Sel.Name == name
}
func voiceUsageShutdownBoundaries(body *ast.BlockStmt) (drain, logs token.Pos, deferred bool) {
	ast.Inspect(body, func(node ast.Node) bool {
		switch value := node.(type) {
		case *ast.DeferStmt:
			if voiceUsageNamedCall(value.Call, "stopVoiceUsageDelivery") {
				deferred = true
			}
		case *ast.CallExpr:
			if voiceUsageMethodCall(value, "srv", "Shutdown") {
				drain = value.Pos()
			}
			if voiceUsageMethodCall(value, "logx", "SetAppSink") {
				logs = value.Pos()
			}
		}
		return true
	})
	return
}
func voiceUsageExplicitJoin(body *ast.BlockStmt) token.Pos {
	return voiceUsageExplicitNamedJoin(body, "stopVoiceUsageDelivery")
}

func voiceUsageExplicitNamedJoin(body *ast.BlockStmt, name string) token.Pos {
	for _, stmt := range body.List {
		expr, ok := stmt.(*ast.ExprStmt)
		if !ok {
			continue
		}
		call, ok := expr.X.(*ast.CallExpr)
		if !ok {
			continue
		}
		if voiceUsageNamedCall(call, name) {
			return stmt.Pos()
		}
	}
	return token.NoPos
}
func TestVoiceUsageDeliveryJoinsAfterHTTPBeforeLogs(t *testing.T) {
	body := voiceUsageMainBody(t)
	drain, logs, deferred := voiceUsageShutdownBoundaries(body)
	join := voiceUsageExplicitJoin(body)
	if !deferred || !join.IsValid() || !drain.IsValid() || !logs.IsValid() || join < drain || join > logs {
		t.Fatal("usage worker must join after HTTP drain, before log/database shutdown, with deferred fallback")
	}
}

func TestVoiceUsageProducersJoinBeforeDeliveryStops(t *testing.T) {
	body := voiceUsageMainBody(t)
	drain, logs, _ := voiceUsageShutdownBoundaries(body)
	delivery := voiceUsageExplicitJoin(body)
	producers := voiceUsageExplicitNamedJoin(body, "stopVoiceUsageProducers")
	if !producers.IsValid() || producers < drain || producers > delivery || delivery > logs {
		t.Fatal("accepted usage producers must join after HTTP drain and before recovery/log shutdown")
	}
	producerDefer := voiceUsageDeferredPosition(body, "stopVoiceUsageProducers")
	workerDefer := voiceUsageDeferredPosition(body, "stopVoiceUsageDelivery")
	if !producerDefer.IsValid() || !workerDefer.IsValid() || producerDefer < workerDefer {
		t.Fatal("fallback cleanup must join producers before stopping recovery")
	}

}

func voiceUsageDeferredPosition(body *ast.BlockStmt, name string) token.Pos {
	var position token.Pos
	ast.Inspect(body, func(node ast.Node) bool {
		if value, ok := node.(*ast.DeferStmt); ok && voiceUsageNamedCall(value.Call, name) {
			position = value.Pos()
		}
		return true
	})
	return position
}
