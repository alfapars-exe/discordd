package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/testutil"
)

// TestPermissionCache_HitMissAndInvalidation locks in the P0-BC-04 hardening:
// effective permissions are cached (so the role repo isn't hit on every
// request), but an explicit InvalidateUserPermissions — called from the
// role-edit / member-removal paths — forces an immediate refresh, so a revoked
// role can't keep authorizing actions until the TTL lapses.
func TestPermissionCache_HitMissAndInvalidation(t *testing.T) {
	var calls int
	repo := &testutil.MockRoleRepo{
		GetByUserIDAndServerFn: func(_ context.Context, _, _ string) ([]models.Role, error) {
			calls++
			return []models.Role{
				{Permissions: models.PermViewChannel},
				{Permissions: models.PermSendMessages},
			}, nil
		},
	}
	mw := NewPermissionMiddleware(repo)
	req := httptest.NewRequest(http.MethodGet, "/", nil)

	// Cold read: cache miss → repo hit; role masks OR'd together.
	got, err := mw.resolveEffectivePerms(req, "user-1", "server-1")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	want := models.PermViewChannel | models.PermSendMessages
	if got != want {
		t.Fatalf("effective perms: want %d, got %d", want, got)
	}
	if calls != 1 {
		t.Fatalf("cold read should hit the repo once, got %d", calls)
	}

	// Warm read within TTL: served from cache, repo NOT consulted again.
	if _, err := mw.resolveEffectivePerms(req, "user-1", "server-1"); err != nil {
		t.Fatalf("resolve (warm): %v", err)
	}
	if calls != 1 {
		t.Fatalf("warm read must be served from cache, got %d repo calls", calls)
	}

	// Role change → explicit invalidation → next read refreshes from the repo.
	mw.InvalidateUserPermissions("user-1")
	if _, err := mw.resolveEffectivePerms(req, "user-1", "server-1"); err != nil {
		t.Fatalf("resolve (post-invalidate): %v", err)
	}
	if calls != 2 {
		t.Fatalf("post-invalidation read must re-hit the repo, got %d", calls)
	}
}

// TestPermissionCache_ServerInvalidationIsScoped verifies InvalidateServerPermissions
// evicts only the targeted server's entries (suffix match), leaving other
// servers' cached permissions intact.
func TestPermissionCache_ServerInvalidationIsScoped(t *testing.T) {
	var calls int
	repo := &testutil.MockRoleRepo{
		GetByUserIDAndServerFn: func(_ context.Context, _, _ string) ([]models.Role, error) {
			calls++
			return []models.Role{{Permissions: models.PermViewChannel}}, nil
		},
	}
	mw := NewPermissionMiddleware(repo)
	req := httptest.NewRequest(http.MethodGet, "/", nil)

	// Warm: two members of server-A, one of server-B.
	mustResolve(t, mw, req, "u1", "server-A")
	mustResolve(t, mw, req, "u2", "server-A")
	mustResolve(t, mw, req, "u3", "server-B")
	if calls != 3 {
		t.Fatalf("setup: want 3 cold lookups, got %d", calls)
	}

	// Editing a server-A role invalidates only server-A members.
	mw.InvalidateServerPermissions("server-A")
	mustResolve(t, mw, req, "u1", "server-A") // evicted → repo hit
	mustResolve(t, mw, req, "u3", "server-B") // untouched → still cached
	if calls != 4 {
		t.Fatalf("server-A invalidation should re-fetch only server-A entries; want 4 calls, got %d", calls)
	}
}

func mustResolve(t *testing.T, mw *PermissionMiddleware, r *http.Request, userID, serverID string) {
	t.Helper()
	if _, err := mw.resolveEffectivePerms(r, userID, serverID); err != nil {
		t.Fatalf("resolve(%s,%s): %v", userID, serverID, err)
	}
}
