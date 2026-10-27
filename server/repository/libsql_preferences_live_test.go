//go:build !windows && cgo && libsql_integration

package repository

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/argeinfina/hichat/database"
	"github.com/google/uuid"
)

// newLiveLibSQLTestDB requires an explicitly disposable loopback database.
func newLiveLibSQLTestDB(t *testing.T) *database.DB {
	t.Helper()
	dsn := os.Getenv("HICHAT_TEST_LIBSQL_DSN")
	if dsn == "" {
		t.Skip("set HICHAT_TEST_LIBSQL_DSN to a disposable loopback server")
	}
	u, err := url.Parse(dsn)
	if err != nil || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost" && u.Hostname() != "::1") {
		t.Fatal("test requires a disposable loopback libSQL server")
	}
	migrations, err := fs.Sub(database.EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatal(err)
	}
	db, err := database.New(dsn, migrations)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func TestLibSQLPreferencesLive(t *testing.T) {
	db := newLiveLibSQLTestDB(t)
	ctx := context.Background()
	userID := "libsql-" + uuid.NewString()
	if _, err := db.Conn.ExecContext(ctx, `INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)`, userID, userID, "x"); err != nil {
		t.Fatal(err)
	}
	repo := NewSQLitePreferencesRepo(wrapForRepo(db))
	if _, err := repo.Upsert(ctx, userID, json.RawMessage(`{"accessibility":{"chatFontSize":18}}`)); err != nil {
		t.Fatal(err)
	}
	got, err := repo.Upsert(ctx, userID, json.RawMessage(`{"accessibility":{"alwaysUnderlineLinks":true}}`))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got.Data), `"chatFontSize":18`) || !strings.Contains(string(got.Data), `"alwaysUnderlineLinks":true`) {
		t.Fatalf("merged preferences lost: %s", got.Data)
	}
	const writers = 8
	start := make(chan struct{})
	errs := make(chan error, writers)
	var wg sync.WaitGroup
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			_, err := repo.Upsert(ctx, userID, json.RawMessage(fmt.Sprintf(`{"sidebar_sections":{"section-%d":true}}`, i)))
			errs <- err
		}(i)
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent update: %v", err)
		}
	}
	got, err = repo.Get(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	var data struct {
		Sidebar map[string]bool `json:"sidebar_sections"`
	}
	if err := json.Unmarshal(got.Data, &data); err != nil {
		t.Fatal(err)
	}
	if len(data.Sidebar) != writers {
		t.Fatalf("concurrent updates lost: %s", got.Data)
	}
}
