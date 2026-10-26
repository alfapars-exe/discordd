package database

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

// Emulate Hrana's explicit stream lifecycle against real SQLite, including
// rollback on close. The separate connection is essential: a database/sql
// pinned connection alone did not preserve remote autocommit PRAGMAs.
func TestRemoteThreadMigrationRetainsStreamAndRollsBack(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(fmt.Sprintf("rollback_%v", fail), func(t *testing.T) {
			conn, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "remote.db")+"?_pragma=foreign_keys(1)")
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			raw, err := fs.ReadFile(EmbeddedMigrations, "migrations/144_thread_channel_type.sql")
			if err != nil {
				t.Fatal(err)
			}
			content := string(raw)
			oldDDL := strings.Split(content, "INSERT INTO channels_thread_type_upgrade")[0]
			oldDDL = strings.ReplaceAll(oldDDL, "channels_thread_type_upgrade", "channels")
			oldDDL = strings.ReplaceAll(oldDDL, "'audit', 'thread'", "'audit'")
			for _, statement := range []string{
				`CREATE TABLE schema_migrations(filename TEXT PRIMARY KEY)`,
				`CREATE TABLE categories(id TEXT PRIMARY KEY)`,
				`CREATE TABLE messages(id TEXT PRIMARY KEY, channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE)`,
				oldDDL,
				`INSERT INTO channels(id,name,type) VALUES('c','existing','text')`,
				`INSERT INTO messages(id,channel_id) VALUES('m','c')`,
				`CREATE INDEX custom_topic_index ON channels(topic)`,
			} {
				if _, err := conn.Exec(statement); err != nil {
					t.Fatal(err)
				}
			}
			var stream *sql.Conn
			closed := false
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("x-turso-encryption-key") != "test-encryption-key" {
					t.Error("missing remote encryption header")
				}
				if r.Header.Get("Authorization") != "Bearer test-private-token" {
					t.Error("missing auth header")
					w.WriteHeader(401)
					return
				}
				if strings.Contains(r.URL.RawQuery, "test-private-token") {
					t.Error("token leaked into URL")
				}
				var request struct {
					Baton    *string `json:"baton"`
					Requests []struct {
						Type string `json:"type"`
						Stmt struct {
							SQL  string             `json:"sql"`
							Args []threadHranaValue `json:"args"`
						} `json:"stmt"`
					} `json:"requests"`
				}
				if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
					t.Error(err)
					return
				}
				if stream == nil {
					if request.Baton != nil {
						t.Error("initial baton must be null")
					}
					stream, err = conn.Conn(context.Background())
					if err != nil {
						t.Error(err)
						return
					}
				} else if request.Baton == nil || *request.Baton != "test-stream" {
					t.Error("stream baton lost")
				}
				operation := request.Requests[0]
				if operation.Type == "close" {
					_, _ = stream.ExecContext(context.Background(), "ROLLBACK")
					_ = stream.Close()
					stream = nil
					closed = true
					_ = json.NewEncoder(w).Encode(map[string]any{"baton": nil, "results": []any{map[string]any{"type": "ok", "response": map[string]any{"type": "close"}}}})
					return
				}
				args := make([]any, len(operation.Stmt.Args))
				for i, value := range operation.Stmt.Args {
					args[i] = value.Value
				}
				rows, queryErr := stream.QueryContext(context.Background(), operation.Stmt.SQL, args...)
				result := threadHranaResult{}
				if queryErr == nil {
					columns, _ := rows.Columns()
					for rows.Next() {
						values := make([]any, len(columns))
						targets := make([]any, len(columns))
						for i := range values {
							targets[i] = &values[i]
						}
						if err := rows.Scan(targets...); err != nil {
							t.Error(err)
						}
						row := make([]threadHranaValue, len(values))
						for i, value := range values {
							switch value := value.(type) {
							case nil:
								row[i] = threadHranaValue{Type: "null"}
							case int64:
								row[i] = threadHranaValue{Type: "integer", Value: fmt.Sprint(value)}
							default:
								row[i] = threadHranaValue{Type: "text", Value: fmt.Sprint(value)}
							}
						}
						result.Rows = append(result.Rows, row)
					}
					queryErr = rows.Err()
					rows.Close()
				}
				outcome := map[string]any{"type": "ok", "response": map[string]any{"type": "execute", "result": result}}
				if queryErr != nil {
					outcome = map[string]any{"type": "error", "error": map[string]any{"code": "SQLITE_ERROR"}}
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"baton": "test-stream", "results": []any{outcome}})
			}))
			defer server.Close()
			db := &DB{Conn: conn, remoteMigrationDSN: server.URL + "?authToken=test-private-token&remoteEncryptionKey=test-encryption-key"}
			if fail {
				content += "\nINSERT INTO missing_table VALUES(1);"
			}
			err = db.applyMigrationFile("144_thread_channel_type.sql", content)
			if fail && err == nil || !fail && err != nil {
				t.Fatalf("migration rollback=%v: %v", fail, err)
			}
			if !closed {
				t.Fatal("remote stream was not closed")
			}
			for _, statement := range []string{`SELECT count(*) FROM channels`, `SELECT count(*) FROM messages`, `SELECT count(*) FROM sqlite_master WHERE name='custom_topic_index'`} {
				var count int
				if err := conn.QueryRow(statement).Scan(&count); err != nil || count != 1 {
					t.Fatalf("preservation count=%d error=%v", count, err)
				}
			}
			var recorded int
			if err := conn.QueryRow(`SELECT count(*) FROM schema_migrations`).Scan(&recorded); err != nil || recorded != map[bool]int{true: 0, false: 1}[fail] {
				t.Fatalf("migration record=%d error=%v", recorded, err)
			}
			if !fail {
				// A second startup may have selected this migration before the
				// first startup committed it. It must recheck under the write lock.
				if err := db.applyMigrationFile("144_thread_channel_type.sql", "INSERT INTO missing_table VALUES(1);"); err != nil {
					t.Fatalf("already-applied migration was executed again: %v", err)
				}
				if _, err := conn.Exec(`INSERT INTO channels(id,name,type,parent_channel_id,starter_message_id) VALUES('t','thread','thread','c','m')`); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}

func TestThreadHranaSessionDoesNotExposeAuthenticationOnErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "private-token-sensitive-response", 401) }))
	defer server.Close()
	s, err := newThreadHranaSession(server.URL + "?authToken=private-token")
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.request(context.Background(), "execute", "PRAGMA foreign_keys")
	if err == nil || strings.Contains(err.Error(), "private-token") || strings.Contains(s.endpoint, "authToken") {
		t.Fatalf("unsafe error or endpoint: %v", err)
	}
}

func TestThreadHranaSessionRejectsLostStreamsAndUnsafeRouting(t *testing.T) {
	for _, response := range []string{
		`{"baton":null,"results":[{"type":"ok","response":{"type":"execute","result":{}}}]}`,
		`{"baton":"next","base_url":"https://untrusted.example","results":[{"type":"ok","response":{"type":"execute","result":{}}}]}`,
		`{"baton":"next","results":[{"type":"ok","response":{"type":"close"}}]}`,
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(response)) }))
		s, err := newThreadHranaSession(server.URL)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := s.request(context.Background(), "execute", "BEGIN"); err == nil {
			t.Fatal("unsafe response accepted")
		}
		server.Close()
	}
	s, err := newThreadHranaSession("libsql://example.turso.io?authToken=private-token")
	if err != nil {
		t.Fatal(err)
	}
	if s.endpoint != "https://example.turso.io/v2/pipeline" || s.token != "private-token" {
		t.Fatal("libsql URL conversion failed")
	}
}
