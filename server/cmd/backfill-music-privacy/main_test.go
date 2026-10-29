package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
)

func TestBackfillCLIDryRunApplyRequiresOfflineAndReviewedTarget(t *testing.T) {
	migrations, err := fs.Sub(database.EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "existing.db")
	db, err := database.NewLegacy(path, migrations)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, q := range []string{`INSERT INTO users(id,username,password_hash) VALUES('retired','retired','hash')`, `INSERT INTO data_exports(id,user_id,status,payload,expires_at) VALUES('old-export','retired','ready','{"private":"secret"}','2099-01-01')`, `UPDATE users SET deleted_at=1 WHERE id='retired'`} {
		if _, err := db.Conn.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("HICHAT_MUSIC_PRIVACY_DATABASE_URL", path)
	var out bytes.Buffer
	if err := run(nil, &out); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), "secret") {
		t.Fatal("dry run disclosed payload")
	}
	var plan maintenancePlan
	if err := json.Unmarshal(out.Bytes(), &plan); err != nil {
		t.Fatal(err)
	}
	if plan.Applied || plan.ExportsRemoved != 1 {
		t.Fatal("default run applied or missed data")
	}
	file := filepath.Join(t.TempDir(), "plan.json")
	if err := os.WriteFile(file, out.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"--apply-plan", file}, &bytes.Buffer{}); err == nil {
		t.Fatal("apply without offline confirmation accepted")
	}
	if err := run([]string{"--apply-plan", file, "--offline-confirmed", "--limit", "1"}, &bytes.Buffer{}); err == nil {
		t.Fatal("changed reviewed limit accepted")
	}
	bad := plan
	bad.TargetHash = strings.Repeat("a", 64)
	encoded, _ := json.Marshal(bad)
	badFile := filepath.Join(t.TempDir(), "wrong-target.json")
	if err := os.WriteFile(badFile, encoded, 0600); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"--apply-plan", badFile, "--offline-confirmed"}, &bytes.Buffer{}); err == nil {
		t.Fatal("foreign database plan accepted")
	}
	if err := run([]string{"--apply-plan", file, "--offline-confirmed"}, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM data_exports`).Scan(&n); err != nil || n != 0 {
		t.Fatal("explicit plan did not apply")
	}
}
func TestBackfillCLINeverCreatesDatabaseAndRejectsRemoteLibSQL(t *testing.T) {
	path := filepath.Join(t.TempDir(), "missing.db")
	t.Setenv("HICHAT_MUSIC_PRIVACY_DATABASE_URL", path)
	if err := run(nil, &bytes.Buffer{}); err == nil {
		t.Fatal("missing database accepted")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("maintenance created a database")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, _, err := openMaintenanceDB(ctx, "libsql://not-a-source"); err == nil {
		t.Fatal("unsupported remote source accepted")
	}
	if err := run([]string{"--limit", "0"}, &bytes.Buffer{}); err == nil {
		t.Fatal("invalid bound accepted")
	}
}
