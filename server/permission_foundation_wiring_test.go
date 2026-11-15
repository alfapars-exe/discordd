package main

import (
	"fmt"
	"github.com/argeinfina/hichat/ws"
	"reflect"
	"testing"
)

func permissionFoundationFixture(t *testing.T) permissionFoundationDependencies {
	return permissionFoundationDependencies{Repositories: startupPolicyRepositories(t), Hub: ws.NewHub()}
}
func expectPermissionFoundationPanic(t *testing.T, deps permissionFoundationDependencies, want string) {
	t.Helper()
	before := routeCacheWorkerCount(t)
	var caught any
	func() { defer func() { caught = recover() }(); group := initPermissionFoundation(deps); group.Stop() }()
	if fmt.Sprint(caught) != want {
		t.Errorf("panic=%v want %s", caught, want)
	}
	if after := routeCacheWorkerCount(t); after != before {
		t.Fatalf("invalid composition leaked cache workers: before=%d after=%d", before, after)
	}
}
func TestPermissionFoundationRejectsMissingIntegration(t *testing.T) {
	base := permissionFoundationFixture(t)
	for _, field := range []string{"Repositories", "Hub"} {
		t.Run(field, func(t *testing.T) {
			deps := base
			v := reflect.ValueOf(&deps).Elem().FieldByName(field)
			v.Set(reflect.Zero(v.Type()))
			expectPermissionFoundationPanic(t, deps, "permission foundation requires "+field)
		})
	}
	deps := base
	var hub *ws.Hub
	deps.Hub = hub
	expectPermissionFoundationPanic(t, deps, "permission foundation requires Hub")
}
func TestPermissionFoundationRejectsMissingRepository(t *testing.T) {
	base := permissionFoundationFixture(t)
	for _, field := range []string{"ChannelPermission", "Role", "Channel"} {
		for _, typedNil := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/typedNil=%v", field, typedNil), func(t *testing.T) {
				deps := base
				repos := *base.Repositories
				deps.Repositories = &repos
				v := reflect.ValueOf(&repos).Elem().FieldByName(field)
				if typedNil {
					v.Set(reflect.Zero(v.Elem().Type()))
				} else {
					v.Set(reflect.Zero(v.Type()))
				}
				expectPermissionFoundationPanic(t, deps, "permission foundation requires repository "+field)
			})
		}
	}
}
func TestPermissionFoundationTransfersAndStopsThreeCacheOwners(t *testing.T) {
	deps := permissionFoundationFixture(t)
	before := routeCacheWorkerCount(t)
	group := initPermissionFoundation(deps)
	t.Cleanup(group.Stop)
	if group.Auth == nil || group.Server == nil || group.Channel == nil || group.Invalidator == nil {
		t.Fatal("missing permission owner")
	}
	if after := routeCacheWorkerCount(t); after != before+3 {
		t.Fatalf("transferred workers=%d want 3", after-before)
	}
	group.Stop()
	group.Stop()
	if after := routeCacheWorkerCount(t); after != before {
		t.Fatalf("Stop retained workers=%d", after-before)
	}
}
