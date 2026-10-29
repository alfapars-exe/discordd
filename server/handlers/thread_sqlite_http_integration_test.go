package handlers

import (
	"context"
	"encoding/json"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

// Exercises production migrations, repositories, permission resolution, thread
// service and handlers over HTTP. Authenticated context is injected here;
// authentication middleware and browser behavior are outside this test.
func TestThreadSQLiteHTTPArchiveAccessAndReopen(t *testing.T) {
	migrations, err := fs.Sub(database.EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatal(err)
	}
	db, err := database.NewLegacy(filepath.Join(t.TempDir(), "threads.db"), migrations)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.Conn.ExecContext(context.Background(), query, args...); err != nil {
			t.Fatal(err)
		}
	}
	for _, user := range []string{"starter", "moderator", "reader"} {
		exec(`INSERT INTO users(id,username,password_hash) VALUES(?,?,?)`, user, user, "test")
	}
	exec(`INSERT INTO servers(id,name,owner_id) VALUES('s','server','moderator')`)
	exec(`INSERT INTO channels(id,server_id,name,type) VALUES('parent','s','parent','text')`)
	exec(`INSERT INTO messages(id,channel_id,user_id,content) VALUES('message','parent','starter','starter message')`)
	read := models.PermViewChannel | models.PermReadMessages | models.PermSendMessages
	for _, user := range []string{"starter", "moderator", "reader"} {
		bits := read
		if user == "moderator" {
			bits |= models.PermManageMessages
		}
		exec(`INSERT INTO server_members(server_id,user_id) VALUES('s',?)`, user)
		exec(`INSERT INTO roles(id,server_id,name,permissions) VALUES(?,'s',?,?)`, user, user, bits)
		exec(`INSERT INTO user_roles(user_id,role_id,server_id) VALUES(?,?,'s')`, user, user)
	}
	q := database.NewRetryingQuerier(db.Conn)
	channels := repository.NewSQLiteChannelRepo(q)
	permissions := services.NewChannelPermissionService(repository.NewSQLiteChannelPermRepo(q), repository.NewSQLiteRoleRepo(q), channels, &testutil.MockBroadcaster{})
	broadcasts := 0
	hub := &testutil.MockBroadcaster{BroadcastToServerFn: func(string, ws.Event) { broadcasts++ }}
	handler := NewThreadHandler(services.NewThreadService(channels, repository.NewSQLiteMessageRepo(q), permissions, hub))
	mux := http.NewServeMux()
	mux.HandleFunc("POST /channels/{channelId}/threads", handler.Create)
	mux.HandleFunc("GET /threads/{threadId}", handler.Get)
	mux.HandleFunc("PATCH /threads/{threadId}/archive", handler.SetArchived)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := context.WithValue(r.Context(), UserContextKey, &models.User{ID: r.Header.Get("X-Test-User")})
		ctx = context.WithValue(ctx, ServerIDContextKey, "s")
		mux.ServeHTTP(w, r.WithContext(ctx))
	}))
	defer server.Close()
	request := func(method, path, user, body string, status int) models.Channel {
		t.Helper()
		r, err := http.NewRequest(method, server.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		r.Header.Set("X-Test-User", user)
		response, err := server.Client().Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		data, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != status {
			t.Fatalf("%s %s as %s: status=%d body=%s want=%d", method, path, user, response.StatusCode, data, status)
		}
		var envelope struct {
			Data models.Channel `json:"data"`
		}
		if status < 300 && json.Unmarshal(data, &envelope) != nil {
			t.Fatalf("invalid channel JSON: %s", data)
		}
		t.Logf("%s %s as %s -> %d", method, path, user, status)
		return envelope.Data
	}
	thread := request("POST", "/channels/parent/threads", "starter", `{"name":"topic","message_id":"message"}`, 201)
	path := "/threads/" + thread.ID
	archive := func(user string, value bool, status int) {
		t.Helper()
		body := `{"archived":false}`
		if value {
			body = `{"archived":true}`
		}
		request("PATCH", path+"/archive", user, body, status)
	}
	assertArchived := func(want bool) {
		t.Helper()
		ch, err := channels.GetByID(context.Background(), thread.ID)
		if err != nil || (ch.ArchivedAt != nil) != want {
			t.Fatalf("persisted archive state: channel=%+v err=%v want=%v", ch, err, want)
		}
	}
	archive("reader", true, 403)
	archive("starter", true, 200)
	assertArchived(true)
	request("GET", path, "reader", "", 200)
	for _, user := range []string{"starter", "moderator"} {
		exec(`INSERT INTO channel_permissions(channel_id,role_id,deny) VALUES('parent',?,?)`, user, models.PermReadMessages)
		permissions.InvalidateUser(user)
		before := broadcasts
		request("GET", path, user, "", 403)
		archive(user, false, 403)
		archive(user, true, 403)
		assertArchived(true)
		if broadcasts != before {
			t.Fatal("denied request broadcast a mutation")
		}
		exec(`DELETE FROM channel_permissions WHERE channel_id='parent' AND role_id=?`, user)
		permissions.InvalidateUser(user)
		archive(user, false, 200)
		assertArchived(false)
		archive(user, true, 200)
		assertArchived(true)
	}
	exec(`UPDATE channels SET type='voice' WHERE id='parent'`)
	request("GET", path, "moderator", "", 404)
	archive("moderator", false, 404)
	assertArchived(true)
}
