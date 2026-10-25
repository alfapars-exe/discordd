package services

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
)

func TestChannelInvalidationSupersedesInflightGrant(t *testing.T) {
	for _, bulk := range []bool{false, true} {
		for _, mode := range []string{"all", "user", "channel"} {
			t.Run(map[bool]string{true: "bulk/", false: "single/"}[bulk]+mode, func(t *testing.T) {
				started, release := make(chan struct{}), make(chan struct{})
				var once sync.Once
				t.Cleanup(func() { once.Do(func() { close(release) }) })
				var calls atomic.Int32
				roles := func(ctx context.Context) ([]models.Role, error) {
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
				}
				rr := &testutil.MockRoleRepo{
					GetByUserIDAndServerFn: func(ctx context.Context, _, _ string) ([]models.Role, error) { return roles(ctx) },
					GetRolesForUsersFn: func(ctx context.Context, _ string, _ []string) (map[string][]models.Role, error) {
						r, err := roles(ctx)
						return map[string][]models.Role{"u": r}, err
					},
				}
				svc := newTestChannelPermService(&testutil.MockChannelPermRepo{}, rr, &testutil.MockChannelRepo{GetByIDFn: func(context.Context, string) (*models.Channel, error) {
					return &models.Channel{ID: "c", ServerID: "s"}, nil
				}}, nil).(*cachingPermResolver)
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				type result struct {
					p   models.Permission
					err error
				}
				done := make(chan result, 1)
				go func() {
					if bulk {
						ps, err := svc.ResolveChannelPermissionsBulk(ctx, "c", []string{"u"})
						done <- result{ps["u"], err}
					} else {
						p, err := svc.ResolveChannelPermissions(ctx, "u", "c")
						done <- result{p, err}
					}
				}()
				select {
				case <-started:
				case <-ctx.Done():
					t.Fatal("lookup not started")
				}
				switch mode {
				case "all":
					svc.InvalidateAll()
				case "user":
					svc.InvalidateUser("u")
				case "channel":
					svc.invalidateChannelCache("c")
				}
				once.Do(func() { close(release) })
				select {
				case got := <-done:
					if got.err != nil || got.p != models.PermViewChannel {
						t.Fatal("superseded grant returned", got)
					}
				case <-ctx.Done():
					t.Fatal("lookup did not finish")
				}
				p, err := svc.ResolveChannelPermissions(ctx, "u", "c")
				if err != nil || p != models.PermViewChannel || calls.Load() != 2 {
					t.Fatal("stale grant cached", p, err, calls.Load())
				}
			})
		}
	}
}

func TestChannelInvalidationChurnFailsClosedAndBounded(t *testing.T) {
	for _, bulk := range []bool{false, true} {
		t.Run(map[bool]string{true: "bulk", false: "single"}[bulk], func(t *testing.T) {
			var svc *cachingPermResolver
			calls := 0
			roles := func() []models.Role {
				calls++
				svc.InvalidateAll()
				return []models.Role{{Permissions: models.PermAdmin}}
			}
			rr := &testutil.MockRoleRepo{GetByUserIDAndServerFn: func(context.Context, string, string) ([]models.Role, error) { return roles(), nil }, GetRolesForUsersFn: func(context.Context, string, []string) (map[string][]models.Role, error) {
				return map[string][]models.Role{"u": roles()}, nil
			}}
			svc = newTestChannelPermService(&testutil.MockChannelPermRepo{}, rr, &testutil.MockChannelRepo{GetByIDFn: func(context.Context, string) (*models.Channel, error) {
				return &models.Channel{ID: "c", ServerID: "s"}, nil
			}}, nil).(*cachingPermResolver)
			var err error
			if bulk {
				var ps map[string]models.Permission
				ps, err = svc.ResolveChannelPermissionsBulk(context.Background(), "c", []string{"u"})
				if ps != nil {
					t.Fatal("partial bulk grant", ps)
				}
			} else {
				var p models.Permission
				p, err = svc.ResolveChannelPermissions(context.Background(), "u", "c")
				if p != 0 {
					t.Fatal("stale single grant", p)
				}
			}
			if !errors.Is(err, pkg.ErrForbidden) || calls != 3 {
				t.Fatal("unbounded retry", err, calls)
			}
		})
	}
}

func TestChannelBulkInvalidationDiscardsMixedCachedAndFreshSnapshot(t *testing.T) {
	fixture := permFixture{serverID: "s", channelID: "c", roles: map[string][]models.Role{
		"alice": {{Permissions: models.PermAdmin}}, "bob": {{Permissions: models.PermAdmin}},
	}}
	svc := fixture.newService(&bulkRepoCounter{}).(*cachingPermResolver)
	if p, err := svc.ResolveChannelPermissions(context.Background(), "alice", "c"); err != nil || p != models.PermAll {
		t.Fatal("warm cache", p, err)
	}
	rr := svc.inner.roleRepo.(*testutil.MockRoleRepo)
	original := rr.GetRolesForUsersFn
	started, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	var calls atomic.Int32
	rr.GetRolesForUsersFn = func(ctx context.Context, serverID string, ids []string) (map[string][]models.Role, error) {
		snapshot, err := original(ctx, serverID, ids)
		if calls.Add(1) == 1 {
			if len(ids) != 1 || ids[0] != "bob" {
				return nil, errors.New("first lookup did not use warm alice cache")
			}
			close(started)
			select {
			case <-release:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		} else if len(ids) != 2 {
			return nil, errors.New("retry reused the invalidated cached half")
		}
		return snapshot, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	type result struct {
		perms map[string]models.Permission
		err   error
	}
	done := make(chan result, 1)
	go func() {
		p, err := svc.ResolveChannelPermissionsBulk(ctx, "c", []string{"alice", "bob"})
		done <- result{p, err}
	}()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("lookup not started")
	}
	fixture.roles["alice"] = []models.Role{{Permissions: models.PermViewChannel}}
	fixture.roles["bob"] = []models.Role{{Permissions: models.PermViewChannel}}
	svc.InvalidateAll()
	once.Do(func() { close(release) })
	select {
	case got := <-done:
		if got.err != nil || got.perms["alice"] != models.PermViewChannel || got.perms["bob"] != models.PermViewChannel || calls.Load() != 2 {
			t.Fatal("mixed stale snapshot returned", got, calls.Load())
		}
	case <-ctx.Done():
		t.Fatal("lookup did not finish")
	}
}
