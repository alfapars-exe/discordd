package main

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInventoryIdentifiesDeclarationOwnersIncludingNestedClosures(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, "server", "repository")
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	source := `package fixture
var global = db.Query("SELECT global")
type repo struct{}
func (r *repo) Find() {
 db.Query(query)
 consume(func(){ db.Exec("DELETE FROM example") })
}
func Other(){ db.Query("SELECT other") }
`
	if err := os.WriteFile(filepath.Join(directory, "queries.go"), []byte(source), 0600); err != nil {
		t.Fatal(err)
	}
	got, err := inventory(root)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(got.Calls)
	if err != nil {
		t.Fatal(err)
	}
	var calls []map[string]any
	if err := json.Unmarshal(encoded, &calls); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 4 {
		t.Fatalf("calls=%v", calls)
	}
	if calls[0]["enclosing_function"] != nil {
		t.Fatalf("global initializer acquired a function: %v", calls[0])
	}
	for _, index := range []int{1, 2} {
		if calls[index]["enclosing_function"] != "Find" || calls[index]["receiver"] != "*repo" || calls[index]["declaration_line"] != float64(4) {
			t.Fatalf("method/closure declaration ownership lost: %v", calls[index])
		}
	}
	if calls[3]["enclosing_function"] != "Other" || calls[3]["receiver"] != nil {
		t.Fatalf("function owner=%v", calls[3])
	}
}

func TestInventorySeparatesLiteralAndUnresolvedCallSites(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, "server", "repository")
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	source := `package fixture
func calls(){
 db.ExecContext(ctx,"SELECT ?",value)
 tx.QueryRow("SELECT ?",value)
 db.PrepareContext(ctx,query)
 db.QueryContext(ctx,"SELECT "+columns)
 unrelated.NotSQL("SELECT ?")
}
`
	for name, body := range map[string]string{"queries.go": source, "queries_test.go": "invalid test source deliberately excluded"} {
		if err := os.WriteFile(filepath.Join(directory, name), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	got, err := inventory(root)
	if err != nil {
		t.Fatal(err)
	}
	if got.Files != 1 || got.Literal != 2 || got.Unresolved != 2 || len(got.Calls) != 4 {
		t.Fatalf("unexpected inventory: %+v", got)
	}
	if got.Calls[0].SQL != "SELECT ?" || got.Calls[1].SQL != "SELECT ?" || got.Calls[2].SQL != "" || got.Calls[3].SQL != "" {
		t.Fatalf("incorrect literal resolution: %+v", got.Calls)
	}
	if got.Calls[0].File != "server/repository/queries.go" || got.Calls[0].Line != 3 {
		t.Fatalf("incorrect source location: %+v", got.Calls[0])
	}
}
func TestInventoryRejectsMissingSource(t *testing.T) {
	if _, err := inventory(t.TempDir()); err == nil {
		t.Fatal("missing repository directory produced a successful inventory")
	}
}

func TestInventoryResolvesConstantsButNotMutableQueries(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "server", "repository")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	source := `package fixture
const base = "SELECT "
func calls() {
 const query = base + "?"
 db.Query(query)
 var mutable = "SELECT ?"
 db.Query(mutable)
 { const query = "DELETE FROM fixture WHERE id=?"; db.Exec(query) }
 db.Query("SELECT " + columns)
}`
	if err := os.WriteFile(filepath.Join(dir, "queries.go"), []byte(source), 0600); err != nil {
		t.Fatal(err)
	}
	got, err := inventory(root)
	if err != nil {
		t.Fatal(err)
	}
	if got.Calls[0].SQL != "SELECT ?" || got.Calls[1].SQL != "" || got.Calls[2].SQL != "DELETE FROM fixture WHERE id=?" || got.Calls[3].SQL != "" {
		t.Fatalf("unsafe or incomplete constant resolution: %+v", got.Calls)
	}
}

func TestConstantSQLRejectsExcessiveExpressionNesting(t *testing.T) {
	expr, err := parser.ParseExpr(strings.Repeat("(", 70) + `"SELECT ?"` + strings.Repeat(")", 70))
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := constantSQL(expr, make(map[*ast.Object]bool)); ok || got != "" {
		t.Fatalf("deep expression accepted: %q, %v", got, ok)
	}
}

// Candidate selection must remain syntactic: all supported method spellings
// count, while too-short calls and non-selector functions remain excluded.
func TestInventoryMethodCandidateBoundaries(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, "server", "repository")
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	methods := []string{"ExecContext", "QueryContext", "QueryRowContext", "PrepareContext", "Exec", "Query", "QueryRow", "Prepare"}
	var source strings.Builder
	source.WriteString("package fixture\nfunc calls(){\n")
	for _, method := range methods {
		args := "\"SELECT ?\""
		short := ""
		if strings.HasSuffix(method, "Context") {
			args = "ctx," + args
			short = "ctx"
		}
		source.WriteString("db." + method + "(" + args + ")\n")
		source.WriteString("db." + method + "(" + short + ")\n")
	}
	source.WriteString("Exec(\"SELECT ?\")\nother.NotSQL(\"SELECT ?\")\n}\n")
	if err := os.WriteFile(filepath.Join(directory, "queries.go"), []byte(source.String()), 0600); err != nil {
		t.Fatal(err)
	}
	got, err := inventory(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Calls) != len(methods) || got.Literal != len(methods) || got.Constants != 0 || got.Unresolved != 0 {
		t.Fatalf("unexpected classification: %+v", got)
	}
	for index, method := range methods {
		site := got.Calls[index]
		if site.Method != method || site.SQL != "SELECT ?" || site.Function != "calls" || site.Line != 3+2*index {
			t.Fatalf("candidate %d: %+v", index, site)
		}
	}
}
