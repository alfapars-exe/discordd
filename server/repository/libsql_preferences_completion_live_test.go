//go:build !windows && cgo && libsql_integration

package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/argeinfina/hichat/database"
	"github.com/google/uuid"
)

func assertLiveLibSQLPreferenceCompletion(t *testing.T, db *database.DB, padding int) {
	t.Helper()
	ctx := context.Background()
	id := "probe-" + uuid.NewString()
	if _, err := db.Conn.ExecContext(ctx, `INSERT INTO users(id,username,password_hash) VALUES(?,?,'x')`, id, id); err != nil {
		t.Fatal(err)
	}
	repo := NewSQLitePreferencesRepo(wrapForRepo(db))
	if _, err := repo.Upsert(ctx, id, json.RawMessage(`{"accessibility":{"chatFontSize":18}}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Upsert(ctx, id, json.RawMessage(`{"accessibility":{"alwaysUnderlineLinks":true}}`)); err != nil {
		t.Fatal(err)
	}
	if padding > 0 {
		seed := map[string]bool{}
		for i := 0; i < padding; i++ {
			seed[fmt.Sprintf("padding-%03d-%s", i, strings.Repeat("x", 230))] = true
		}
		payload, _ := json.Marshal(map[string]any{"sidebar_sections": seed})
		if _, err := repo.Upsert(ctx, id, payload); err != nil {
			t.Fatal(err)
		}
	}
	start := make(chan struct{})
	results := make(chan string, 8)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			p, err := repo.Upsert(ctx, id, json.RawMessage(fmt.Sprintf(`{"sidebar_sections":{"section-%d":true}}`, i)))
			if err != nil {
				results <- "ERROR:" + err.Error()
				return
			}
			var snapshot struct {
				Sidebar map[string]bool `json:"sidebar_sections"`
			}
			_ = json.Unmarshal(p.Data, &snapshot)
			results <- fmt.Sprintf("writer%d sections=%d own=%v", i, len(snapshot.Sidebar), snapshot.Sidebar[fmt.Sprintf("section-%d", i)])
		}(i)
	}
	close(start)
	wg.Wait()
	close(results)
	returned := make([]string, 0, 8)
	for result := range results {
		if !strings.HasSuffix(result, "own=true") {
			t.Fatalf("writer did not acknowledge its own patch: %s", result)
		}
		returned = append(returned, result)
	}
	p, err := repo.Get(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Sidebar map[string]bool `json:"sidebar_sections"`
	}
	if err = json.Unmarshal(p.Data, &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Sidebar) != 8+padding {
		fresh, err := sql.Open("libsql", os.Getenv("HICHAT_TEST_LIBSQL_DSN"))
		if err != nil {
			t.Fatal(err)
		}
		defer fresh.Close()
		var raw string
		freshErr := fresh.QueryRowContext(ctx, `SELECT data FROM user_preferences WHERE user_id=?`, id).Scan(&raw)
		again, againErr := repo.Get(ctx, id)
		var stored struct {
			Sidebar map[string]bool `json:"sidebar_sections"`
		}
		_ = json.Unmarshal([]byte(raw), &stored)
		var repeated struct {
			Sidebar map[string]bool `json:"sidebar_sections"`
		}
		if again != nil {
			_ = json.Unmarshal(again.Data, &repeated)
		}
		t.Fatalf("firstCount=%d freshCount=%d freshErr=%v againCount=%d againErr=%v returned=%q", len(got.Sidebar), len(stored.Sidebar), freshErr, len(repeated.Sidebar), againErr, returned)
	}
}
