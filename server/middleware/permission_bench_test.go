// Benchmarks for PermissionMiddleware's TTL-cached resolveEffectivePerms —
// the per-request hot path exercised by every permission-gated route.
package middleware

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/testutil"
)

// benchPermMiddleware builds a PermissionMiddleware backed by a MockRoleRepo
// that always resolves the same two-role permission set. The repo call
// itself is cheap by design — what these benchmarks measure is the cache
// (TTLCache.Get/Set/DeleteFunc) and lock overhead around it, same pattern
// as permission_test.go's TestPermissionCache_* table.
func benchPermMiddleware() *PermissionMiddleware {
	repo := &testutil.MockRoleRepo{
		GetByUserIDAndServerFn: func(_ context.Context, _, _ string) ([]models.Role, error) {
			return []models.Role{
				{Permissions: models.PermViewChannel},
				{Permissions: models.PermSendMessages},
			}, nil
		},
	}
	return NewPermissionMiddleware(repo)
}

// BenchmarkResolveEffectivePerms_CacheHit measures the steady-state read
// path: the same (userID, serverID) key resolved repeatedly, always served
// from the TTL cache after the one warmup miss.
func BenchmarkResolveEffectivePerms_CacheHit(b *testing.B) {
	mw := benchPermMiddleware()
	defer mw.permCache.Close()
	req := httptest.NewRequest(http.MethodGet, "/", nil)

	if _, err := mw.resolveEffectivePerms(req, "user-1", "server-1"); err != nil {
		b.Fatalf("warmup resolve: %v", err)
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := mw.resolveEffectivePerms(req, "user-1", "server-1"); err != nil {
			b.Fatalf("resolve: %v", err)
		}
	}
}

// BenchmarkResolveEffectivePerms_CacheMiss measures the cold path: a
// distinct (userID, serverID) key every call, so the cache never has a
// chance to serve it and every iteration pays the repo round-trip + Set.
func BenchmarkResolveEffectivePerms_CacheMiss(b *testing.B) {
	mw := benchPermMiddleware()
	defer mw.permCache.Close()
	req := httptest.NewRequest(http.MethodGet, "/", nil)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		userID := fmt.Sprintf("user-%d", i)
		if _, err := mw.resolveEffectivePerms(req, userID, "server-1"); err != nil {
			b.Fatalf("resolve: %v", err)
		}
	}
}

// BenchmarkResolveEffectivePerms_ConcurrentInvalidation stresses the cache
// under mixed read/invalidate load: most parallel goroutines resolve
// (cache hit), while a fraction call InvalidateUserPermissions concurrently
// so DeleteFunc's full-map scan runs under the same RWMutex readers are
// hitting via Get — the shape of a busy server during a burst of
// kick/ban/role-reassign events that each invalidate one user.
func BenchmarkResolveEffectivePerms_ConcurrentInvalidation(b *testing.B) {
	mw := benchPermMiddleware()
	defer mw.permCache.Close()
	req := httptest.NewRequest(http.MethodGet, "/", nil)

	const numUsers = 100
	for i := 0; i < numUsers; i++ {
		userID := fmt.Sprintf("user-%d", i)
		if _, err := mw.resolveEffectivePerms(req, userID, "server-1"); err != nil {
			b.Fatalf("warmup resolve: %v", err)
		}
	}

	var counter atomic.Int64

	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			i := counter.Add(1)
			userID := fmt.Sprintf("user-%d", i%numUsers)
			// Every 50th op is an invalidation instead of a read, so
			// DeleteFunc's O(cache size) scan runs interleaved with readers.
			if i%50 == 0 {
				mw.InvalidateUserPermissions(userID)
				continue
			}
			if _, err := mw.resolveEffectivePerms(req, userID, "server-1"); err != nil {
				b.Fatalf("resolve: %v", err)
			}
		}
	})
}
