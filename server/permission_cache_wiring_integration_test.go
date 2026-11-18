package main

import (
	"context"
	"github.com/argeinfina/hichat/config"
	"github.com/argeinfina/hichat/handlers"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPermissionCacheProductionWiringRevokesPrimedRole(t *testing.T) {
	db, _ := newCensusDB(t)
	cfg := &config.Config{}
	cfg.Upload.Dir = t.TempDir()
	repos := initRepositories(db.Conn, repository.DataExportStorageOptions{UploadDir: cfg.Upload.Dir, ArchiveDir: t.TempDir()})
	bundle, limiters, metrics := initServices(db.Conn, repos, ws.NewHub(), cfg, nil, nil)
	t.Cleanup(func() {
		limiters.Stop()
		metrics.Stop()
		stopServiceCacheWorkers(bundle)
		bundle.Voice.ShutdownVoiceStateFanout()
		bundle.OnlineFriendNotifier.Stop()
		bundle.LinkPreview.Stop()
	})
	ctx := context.Background()
	for _, id := range []string{"perm-owner", "perm-target"} {
		if _, err := db.Conn.Exec(`INSERT INTO users(id,username,password_hash) VALUES(?,?,?)`, id, id, "fixture"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Conn.Exec(`INSERT INTO servers(id,name,owner_id) VALUES(?,?,?)`, "perm-server", "fixture", "perm-owner"); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"perm-owner", "perm-target"} {
		if _, err := db.Conn.Exec(`INSERT INTO server_members(server_id,user_id) VALUES(?,?)`, "perm-server", id); err != nil {
			t.Fatal(err)
		}
	}
	for _, role := range []struct {
		id, user   string
		position   int
		permission models.Permission
		owner      bool
	}{
		{"owner-role", "perm-owner", 10, models.PermAll, true},
		{"target-role", "perm-target", 1, models.PermManageMessages, false},
	} {
		if _, err := db.Conn.Exec(`INSERT INTO roles(id,server_id,name,position,permissions,is_owner) VALUES(?,?,?,?,?,?)`, role.id, "perm-server", role.id, role.position, role.permission, role.owner); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Conn.Exec(`INSERT INTO user_roles(user_id,role_id,server_id) VALUES(?,?,?)`, role.user, role.id, "perm-server"); err != nil {
			t.Fatal(err)
		}
	}
	auth, permissions := initRoutes(&recordingRegistrar{}, &Handlers{}, bundle.Auth, repos.User, repos.Role, repos.Server, nil, nil, nil, bundle.AuthCache, bundle.PermissionCache)
	t.Cleanup(auth.Stop)
	t.Cleanup(permissions.Stop)
	endpoint := permissions.Require(models.PermManageMessages, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	request := func() int {
		r := httptest.NewRequest("GET", "/moderate", nil)
		c := context.WithValue(r.Context(), handlers.UserContextKey, &models.User{ID: "perm-target"})
		r = r.WithContext(context.WithValue(c, handlers.ServerIDContextKey, "perm-server"))
		w := httptest.NewRecorder()
		endpoint.ServeHTTP(w, r)
		return w.Code
	}
	if status := request(); status != http.StatusNoContent {
		t.Fatalf("initial permission status=%d", status)
	}
	revoked := models.Permission(0)
	if _, err := bundle.Role.Update(ctx, "perm-server", "perm-owner", "target-role", &models.UpdateRoleRequest{Permissions: &revoked}); err != nil {
		t.Fatal(err)
	}
	if status := request(); status != http.StatusForbidden {
		t.Fatalf("revoked cached role status=%d", status)
	}
}
