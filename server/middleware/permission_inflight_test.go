package middleware

import (
	"context"
	"errors"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
)

func TestPermissionInvalidationSupersedesInflightGrant(t *testing.T) {
	for _, mode := range []string{"all", "user", "server"} {
		t.Run(mode, func(t *testing.T) {
			started, release := make(chan struct{}), make(chan struct{})
			var once sync.Once
			t.Cleanup(func() { once.Do(func() { close(release) }) })
			var calls atomic.Int32
			repo := &testutil.MockRoleRepo{GetByUserIDAndServerFn: func(ctx context.Context, _, _ string) ([]models.Role, error) {
				if calls.Add(1) == 1 {
					close(started)
					select {
					case <-release:
					case <-ctx.Done():
						return nil, ctx.Err()
					}
					return []models.Role{{Permissions: models.PermAdmin}}, nil
				}
				return []models.Role{{Permissions: models.PermViewChannel}}, nil
			}}
			mw := NewPermissionMiddleware(repo)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			req := httptest.NewRequest("GET", "/", nil).WithContext(ctx)
			type result struct {
				perm models.Permission
				err  error
			}
			done := make(chan result, 1)
			go func() { p, err := mw.resolveEffectivePerms(req, "u", "s"); done <- result{p, err} }()
			select {
			case <-started:
			case <-ctx.Done():
				t.Fatal("lookup did not start")
			}
			// Invalidation completes while the old database result is withheld.
			switch mode {
			case "all":
				mw.InvalidateAll()
			case "user":
				mw.InvalidateUser("u")
			case "server":
				mw.InvalidateServerPermissions("s")
			}
			once.Do(func() { close(release) })
			select {
			case got := <-done:
				if got.err != nil || got.perm != models.PermViewChannel {
					t.Fatal("superseded grant returned", got)
				}
			case <-ctx.Done():
				t.Fatal("lookup did not finish")
			}
			p, err := mw.resolveEffectivePerms(req, "u", "s")
			if err != nil || p != models.PermViewChannel || calls.Load() != 2 {
				t.Fatal("stale grant cached", p, err, calls.Load())
			}
		})
	}
}

func TestPermissionInvalidationChurnFailsClosedAndBounded(t *testing.T) {
	var mw *PermissionMiddleware
	calls := 0
	mw = NewPermissionMiddleware(&testutil.MockRoleRepo{GetByUserIDAndServerFn: func(context.Context, string, string) ([]models.Role, error) {
		calls++
		mw.InvalidateAll()
		return []models.Role{{Permissions: models.PermAdmin}}, nil
	}})
	p, err := mw.resolveEffectivePerms(httptest.NewRequest("GET", "/", nil), "u", "s")
	if p != 0 || !errors.Is(err, pkg.ErrForbidden) || calls != 3 {
		t.Fatal("unbounded or stale grant", p, err, calls)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = mw.resolveEffectivePerms(httptest.NewRequest("GET", "/", nil).WithContext(ctx), "u", "s")
	if !errors.Is(err, context.Canceled) || calls != 3 {
		t.Fatal("cancelled lookup reached repository", err, calls)
	}
}
