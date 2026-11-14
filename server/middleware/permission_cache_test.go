package middleware

import (
	"context"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/testutil"
	"net/http/httptest"
	"testing"
)

func TestPermissionMiddlewareSharedOwnerPublishesFreshGrant(t *testing.T) {
	owner := NewPermissionCache()
	grant := models.PermAdmin
	calls := 0
	repo := &testutil.MockRoleRepo{GetByUserIDAndServerFn: func(context.Context, string, string) ([]models.Role, error) {
		calls++
		return []models.Role{{Permissions: grant}}, nil
	}}
	first := NewPermissionMiddleware(repo, owner)
	second := NewPermissionMiddleware(repo, owner)
	t.Cleanup(first.Stop)
	t.Cleanup(second.Stop)
	req := httptest.NewRequest("GET", "/", nil)
	for _, reader := range []*PermissionMiddleware{first, second} {
		got, err := reader.resolveEffectivePerms(req, "user", "server")
		if err != nil || got != models.PermAdmin {
			t.Fatal("initial shared grant differs")
		}
	}
	if calls != 1 {
		t.Fatal("second middleware did not share cached grant")
	}
	grant = models.PermViewChannel
	owner.InvalidateUser("user")
	for _, reader := range []*PermissionMiddleware{second, first} {
		got, err := reader.resolveEffectivePerms(req, "user", "server")
		if err != nil || got != models.PermViewChannel {
			t.Fatal("revoked grant survived owner invalidation")
		}
	}
	if calls != 2 {
		t.Fatal("fresh grant not shared after invalidation")
	}
}
