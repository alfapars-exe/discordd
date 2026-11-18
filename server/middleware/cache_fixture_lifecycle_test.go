package middleware

import (
	"bytes"
	"github.com/argeinfina/hichat/testutil"
	"runtime/pprof"
	"testing"
)

func middlewareFixtureCacheWorkers(t *testing.T) int {
	t.Helper()
	var stacks bytes.Buffer
	if err := pprof.Lookup("goroutine").WriteTo(&stacks, 2); err != nil {
		t.Fatal(err)
	}
	return bytes.Count(stacks.Bytes(), []byte("created by github.com/argeinfina/hichat/pkg/cache.New["))
}

func TestMiddlewareFixturesReleaseOwnedCacheWorkers(t *testing.T) {
	for _, fixture := range []struct {
		name string
		run  func(*testing.T)
	}{
		{"auth_scopes", TestRequire_RejectsScopedTokens},
		{"session_boundary", TestSessionBoundaryIsCheckedEvenWithWarmUserCache},
		{"bot_token", TestRequire_BotTokenSetsBotUser},
		{"banned_bot", TestRequire_BannedBotRejected},
		{"profile_write", TestProfileWriteImmediatelyRefreshesAuthenticatedMe},
		{"permission_cache", TestPermissionCache_HitMissAndInvalidation},
		{"scoped_invalidation", TestPermissionCache_ServerInvalidationIsScoped},
		{"role_http", TestRolePermissionHTTPAllowAndDeny},
		{"inflight_grant", TestPermissionInvalidationSupersedesInflightGrant},
		{"invalidation_churn", TestPermissionInvalidationChurnFailsClosedAndBounded},
		{"shutdown_control", TestCacheBackedMiddlewareExposeIdempotentWorkerStop},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			before := middlewareFixtureCacheWorkers(t)
			t.Run("owner", fixture.run)
			testutil.AssertWorkerCount(t, before, func() int { return middlewareFixtureCacheWorkers(t) })
		})
	}
}
