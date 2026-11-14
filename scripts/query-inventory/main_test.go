package main

import (
	"os"
	"path/filepath"
	"testing"
)

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
