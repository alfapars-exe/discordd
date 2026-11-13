package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"testing"
)

func TestVoiceUsageDeliveryJoinsAfterHTTPBeforeLogs(t *testing.T) {
	file, err := parser.ParseFile(token.NewFileSet(), "main.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	var body *ast.BlockStmt
	for _, decl := range file.Decls {
		if f, ok := decl.(*ast.FuncDecl); ok && f.Name.Name == "main" {
			body = f.Body
		}
	}
	if body == nil {
		t.Fatal("main missing")
	}
	var drain, logs, join token.Pos
	deferred := false
	ast.Inspect(body, func(n ast.Node) bool {
		if d, ok := n.(*ast.DeferStmt); ok {
			if f, ok := d.Call.Fun.(*ast.Ident); ok && f.Name == "stopVoiceUsageDelivery" {
				deferred = true
			}
		}
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		receiver, ok := sel.X.(*ast.Ident)
		if !ok {
			return true
		}
		if receiver.Name == "srv" && sel.Sel.Name == "Shutdown" {
			drain = call.Pos()
		}
		if receiver.Name == "logx" && sel.Sel.Name == "SetAppSink" {
			logs = call.Pos()
		}
		return true
	})
	for _, stmt := range body.List {
		if e, ok := stmt.(*ast.ExprStmt); ok {
			if c, ok := e.X.(*ast.CallExpr); ok {
				if f, ok := c.Fun.(*ast.Ident); ok && f.Name == "stopVoiceUsageDelivery" {
					join = stmt.Pos()
				}
			}
		}
	}
	if !deferred || !join.IsValid() || !drain.IsValid() || !logs.IsValid() || join < drain || join > logs {
		t.Fatal("usage worker must join after HTTP drain, before log/database shutdown, with deferred fallback")
	}
}
