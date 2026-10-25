package handlers

import (
	"context"
	"encoding/json"
	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/testutil"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestGroupAdmissionHTTPRealServiceKnownIDAndActorCannotBypassFriendGate(t *testing.T) {
	migrations, err := fs.Sub(database.EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatal(err)
	}
	db, err := database.New(filepath.Join(t.TempDir(), "group_admission.db"), migrations)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, id := range []string{"owner", "friend", "target"} {
		if _, err := db.Conn.Exec(`INSERT INTO users(id,username,password_hash,dm_privacy) VALUES(?,?,'x','message_request')`, id, id); err != nil {
			t.Fatal(err)
		}
	}
	groups := repository.NewSQLiteGroupDMRepo(db.Conn)
	svc := services.NewGroupDMService(groups, repository.NewSQLiteUserRepo(db.Conn), repository.NewSQLiteFriendshipRepo(db.Conn), &testutil.MockBroadcaster{}, "", "", "", nil, "")
	handler := &GroupDMHandler{service: svc}
	request := func(fn http.HandlerFunc, body, actor, group string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(http.MethodPost, "/api/group-dms", strings.NewReader(body))
		r.SetPathValue("groupId", group)
		r = r.WithContext(context.WithValue(r.Context(), UserContextKey, &models.User{ID: actor}))
		w := httptest.NewRecorder()
		fn(w, r)
		return w
	}
	for _, body := range []string{`{"name":"Group","user_ids":["target"]}`, `{"name":"Group","user_ids":["target"],"admission_actor":"friend"}`} {
		w := request(handler.Create, body, "owner", "")
		if w.Code != http.StatusForbidden && w.Code != http.StatusBadRequest {
			t.Fatalf("create=%d %s", w.Code, w.Body.String())
		}
	}
	if _, err := db.Conn.Exec(`INSERT INTO friendships(id,user_id,friend_id,status) VALUES('friendship','owner','friend','accepted')`); err != nil {
		t.Fatal(err)
	}
	created := request(handler.Create, `{"name":"Group","user_ids":["friend"]}`, "owner", "")
	if created.Code != http.StatusCreated {
		t.Fatalf("accepted create=%d %s", created.Code, created.Body.String())
	}
	var data struct{ Data models.GroupDM }
	if err := json.Unmarshal(created.Body.Bytes(), &data); err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{`{"user_id":"target"}`, `{"user_id":"target","admission_actor":"friend"}`} {
		w := request(handler.AddMember, body, "owner", data.Data.ID)
		if w.Code != http.StatusForbidden && w.Code != http.StatusBadRequest {
			t.Fatalf("add=%d %s", w.Code, w.Body.String())
		}
	}
	denied := request(handler.CallToken, `{}`, "target", data.Data.ID)
	if denied.Code != http.StatusNotFound {
		t.Fatalf("nonmember token=%d %s", denied.Code, denied.Body.String())
	}
	g, err := groups.GetByID(context.Background(), data.Data.ID)
	if err != nil || g.KeyEpoch != 1 {
		t.Fatalf("denied add rekeyed group=%v err=%v", g, err)
	}
	var count int
	if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM notifications`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("denied admission inbox=%d err=%v", count, err)
	}
	if _, err := db.Conn.Exec(`INSERT INTO friendships(id,user_id,friend_id,status) VALUES('target-friend','target','owner','accepted')`); err != nil {
		t.Fatal(err)
	}
	added := request(handler.AddMember, `{"user_id":"target"}`, "owner", data.Data.ID)
	if added.Code != http.StatusOK {
		t.Fatalf("accepted add=%d %s", added.Code, added.Body.String())
	}
}
