package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"testing"
)

// Workers may still write delivery state while HTTP requests drain. Join them
// after draining HTTP and before stopping log sinks or closing their database.
func TestDeliveryWorkersJoinAfterHTTPDrainBeforeLogShutdown(t *testing.T) {
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
	var drain, logs token.Pos
	joins := map[string]token.Pos{"stopChannelDelivery": 0, "stopDMDelivery": 0, "stopDMUploadCleanup": 0}
	ast.Inspect(body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		if sel, ok := call.Fun.(*ast.SelectorExpr); ok {
			if receiver, ok := sel.X.(*ast.Ident); ok && receiver.Name == "srv" && sel.Sel.Name == "Shutdown" {
				drain = call.Pos()
			}
			if receiver, ok := sel.X.(*ast.Ident); ok && receiver.Name == "logx" && sel.Sel.Name == "SetAppSink" {
				logs = call.Pos()
			}
		}
		return true
	})
	// Only unconditional top-level calls count, not deferred or nested cleanup.
	for _, stmt := range body.List {
		expr, ok := stmt.(*ast.ExprStmt)
		if !ok {
			continue
		}
		call, ok := expr.X.(*ast.CallExpr)
		if !ok {
			continue
		}
		name, ok := call.Fun.(*ast.Ident)
		if !ok {
			continue
		}
		if _, ok := joins[name.Name]; ok {
			joins[name.Name] = stmt.Pos()
		}
	}
	if !drain.IsValid() || !logs.IsValid() {
		t.Fatal("HTTP/log shutdown boundaries missing")
	}
	for name, pos := range joins {
		if !pos.IsValid() || pos < drain || pos > logs {
			t.Errorf("%s must join after HTTP drain and before log shutdown", name)
		}
	}
}
