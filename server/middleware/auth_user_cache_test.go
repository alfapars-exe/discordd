package middleware

import (
	"github.com/argeinfina/hichat/models"
	"testing"
)

func TestAuthMiddlewareSharedCacheInvalidation(t *testing.T) {
	owner := NewAuthUserCache()
	first := NewAuthMiddleware(nil, nil, nil, owner)
	second := NewAuthMiddleware(nil, nil, nil, owner)
	t.Cleanup(first.Stop)
	t.Cleanup(second.Stop)
	user := &models.User{ID: "shared-owner"}
	owner.Set(user.ID, user)
	if got, ok := second.userCache.Get(user.ID); !ok || got != user {
		t.Fatal("middleware did not use injected owner")
	}
	first.InvalidateUser(user.ID)
	if _, ok := second.userCache.Get(user.ID); ok {
		t.Fatal("shared invalidation left stale identity")
	}
}
func TestAuthMiddlewareStandaloneCacheIsolation(t *testing.T) {
	first := NewAuthMiddleware(nil, nil, nil, nil)
	second := NewAuthMiddleware(nil, nil, nil, nil)
	t.Cleanup(first.Stop)
	t.Cleanup(second.Stop)
	first.userCache.Set("owner", &models.User{ID: "owner"})
	if _, ok := second.userCache.Get("owner"); ok {
		t.Fatal("standalone owners shared identities")
	}
}
