package main

import (
	"context"
	"github.com/argeinfina/hichat/config"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
	"golang.org/x/crypto/bcrypt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAuthCacheProductionWiringRevokesPrimedIdentity(t *testing.T) {
	db, _ := newCensusDB(t)
	cfg := &config.Config{}
	cfg.Upload.Dir = t.TempDir()
	cfg.JWT.Secret = "auth-cache-wiring-fixture-key"
	cfg.JWT.AccessTokenExpiry = 15
	cfg.JWT.RefreshTokenExpiry = 7
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
	hash, err := bcrypt.GenerateFromPassword([]byte("fixture-password"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	user := &models.User{Username: "cache_fixture", PasswordHash: string(hash), Status: models.UserStatusOnline}
	ctx := context.Background()
	if err := repos.User.Create(ctx, user); err != nil {
		t.Fatal(err)
	}
	tokens, err := bundle.Auth.Login(ctx, &models.LoginRequest{Username: user.Username, Password: "fixture-password"})
	if err != nil {
		t.Fatal(err)
	}
	auth, permissions := initRoutes(&recordingRegistrar{}, &Handlers{}, bundle.Auth, repos.User, repos.Role, repos.Server, nil, nil, nil, bundle.AuthCache)
	t.Cleanup(permissions.Stop)
	t.Cleanup(auth.Stop)
	endpoint := auth.Require(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	request := func() int {
		r := httptest.NewRequest(http.MethodGet, "/private", nil)
		r.Header.Set("Authorization", "Bearer "+tokens.AccessToken)
		w := httptest.NewRecorder()
		endpoint.ServeHTTP(w, r)
		return w.Code
	}
	if status := request(); status != http.StatusNoContent {
		t.Fatalf("initial status=%d", status)
	}
	if _, ok := bundle.AuthCache.Get(user.ID); !ok {
		t.Fatal("identity was not primed in shared owner")
	}
	bundle.AuthCache.Set("unrelated", &models.User{ID: "unrelated"})
	if err := bundle.Auth.LogoutAllDevices(ctx, user.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok := bundle.AuthCache.Get(user.ID); ok {
		t.Fatal("credential action did not invalidate shared owner")
	}
	if _, ok := bundle.AuthCache.Get("unrelated"); !ok {
		t.Fatal("unrelated identity invalidated")
	}
	if status := request(); status != http.StatusUnauthorized {
		t.Fatalf("revoked token status=%d", status)
	}
}
