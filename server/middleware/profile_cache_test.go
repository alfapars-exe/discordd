package middleware

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/handlers"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/testutil"
)

func TestProfileWriteImmediatelyRefreshesAuthenticatedMe(t *testing.T) {
	migrations, err := filepath.Abs("../database/migrations")
	if err != nil {
		t.Fatal(err)
	}
	db, err := database.New(filepath.Join(t.TempDir(), "profile-cache.db"), os.DirFS(migrations))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	users := repository.NewSQLiteUserRepo(db.Conn)
	hub := &testutil.MockEventPublisher{}
	auth := services.NewAuthService(users, repository.NewSQLiteSessionRepo(db.Conn), nil, hub, nil,
		testJWTSecret, 15, 7, services.WithAuthSessions(repository.NewSQLiteAuthSessionRepo(db.Conn)))
	register := func(name string) *services.AuthTokens {
		t.Helper()
		tokens, err := auth.Register(context.Background(), &models.CreateUserRequest{
			Username: name, Password: "profile-cache-password", Email: name + "@example.test",
		})
		if err != nil {
			t.Fatal(err)
		}
		return tokens
	}
	a, b := register("profile_cache_a"), register("profile_cache_b")
	mw := NewAuthMiddleware(auth, users, nil)
	member := services.NewMemberService(users, nil, nil, nil, &testutil.MockServerRepo{}, hub, nil, nil)
	member.SetUserCacheInvalidator(mw)
	authHandler := handlers.NewAuthHandler(auth, nil, nil, nil, nil, nil, nil)
	memberHandler := handlers.NewMemberHandler(member)
	mux := http.NewServeMux()
	mux.Handle("GET /api/users/me", mw.Require(http.HandlerFunc(authHandler.Me)))
	mux.Handle("PATCH /api/users/me/profile", mw.Require(http.HandlerFunc(memberHandler.UpdateProfile)))
	request := func(tokens *services.AuthTokens, method, path, body string, want int) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+tokens.AccessToken)
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != want {
			t.Fatalf("%s %s: status %d, want %d: %s", method, path, rec.Code, want, rec.Body.String())
		}
		return rec
	}
	request(a, http.MethodGet, "/api/users/me", "", http.StatusOK)
	request(b, http.MethodGet, "/api/users/me", "", http.StatusOK)
	otherCached, ok := mw.userCache.Get(b.User.ID)
	if !ok {
		t.Fatal("unrelated user's cache was not warmed")
	}
	request(a, http.MethodPatch, "/api/users/me/profile", `{"bio":"Yerel kabul testi — HiChat."}`, http.StatusOK)
	// Same bearer and logical session, no sleep or cache TTL adjustment.
	rec := request(a, http.MethodGet, "/api/users/me", "", http.StatusOK)
	var envelope struct {
		Data models.User `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Data.Bio == nil || *envelope.Data.Bio != "Yerel kabul testi — HiChat." {
		t.Fatalf("immediate /me returned stale bio: %s", rec.Body.String())
	}
	if cached, ok := mw.userCache.Get(b.User.ID); !ok || cached != otherCached {
		t.Fatal("profile write evicted an unrelated user's cache")
	}
	beforeFailedWrite, ok := mw.userCache.Get(a.User.ID)
	if !ok {
		t.Fatal("edited user's cache was not rewarmed")
	}
	if _, err := db.Conn.Exec(`CREATE TRIGGER reject_profile_update BEFORE UPDATE ON users BEGIN SELECT RAISE(ABORT, 'fixture rejected update'); END`); err != nil {
		t.Fatal(err)
	}
	request(a, http.MethodPatch, "/api/users/me/profile", `{"bio":"must not save"}`, http.StatusInternalServerError)
	if cached, ok := mw.userCache.Get(a.User.ID); !ok || cached != beforeFailedWrite {
		t.Fatal("failed profile write invalidated the cache")
	}
	rec = request(a, http.MethodGet, "/api/users/me", "", http.StatusOK)
	if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Data.Bio == nil || *envelope.Data.Bio != "Yerel kabul testi — HiChat." {
		t.Fatal("failed profile write changed the visible bio")
	}
}
