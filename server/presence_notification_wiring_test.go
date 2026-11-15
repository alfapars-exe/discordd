package main

import (
	"fmt"
	"github.com/argeinfina/hichat/ws"
	"reflect"
	"testing"
)

func presenceNotificationFixture(t *testing.T) presenceNotificationDependencies {
	return presenceNotificationDependencies{Repositories: startupPolicyRepositories(t), Hub: ws.NewHub()}
}
func expectPresenceNotificationPanic(t *testing.T, deps presenceNotificationDependencies, want string) {
	t.Helper()
	var caught any
	func() {
		defer func() { caught = recover() }()
		group := initPresenceNotificationServices(deps)
		group.OnlineFriends.Stop()
	}()
	if fmt.Sprint(caught) != want {
		t.Fatalf("panic=%v want %s", caught, want)
	}
}
func TestPresenceNotificationsRejectMissingIntegration(t *testing.T) {
	base := presenceNotificationFixture(t)
	for _, field := range []string{"Repositories", "Hub"} {
		t.Run(field, func(t *testing.T) {
			deps := base
			v := reflect.ValueOf(&deps).Elem().FieldByName(field)
			v.Set(reflect.Zero(v.Type()))
			expectPresenceNotificationPanic(t, deps, "presence notifications requires "+field)
		})
	}
	deps := base
	var hub *ws.Hub
	deps.Hub = hub
	expectPresenceNotificationPanic(t, deps, "presence notifications requires Hub")
}
func TestPresenceNotificationsRejectMissingRepository(t *testing.T) {
	base := presenceNotificationFixture(t)
	for _, field := range []string{"Preferences", "Friendship", "Notification", "User"} {
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
				expectPresenceNotificationPanic(t, deps, "presence notifications requires repository "+field)
			})
		}
	}
}
func TestPresenceNotificationsValidCompositionRetainsOwners(t *testing.T) {
	group := initPresenceNotificationServices(presenceNotificationFixture(t))
	if group.ProfileUpdates == nil || group.OnlineFriends == nil {
		t.Fatal("missing presence notification owner")
	}
	group.OnlineFriends.Stop()
	group.OnlineFriends.Stop()
}
