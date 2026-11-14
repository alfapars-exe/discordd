package main

import (
	"fmt"
	"reflect"
	"testing"
)

func personalMessagingFixture(t *testing.T) personalMessagingDependencies {
	return personalMessagingDependencies{Repositories: startupPolicyRepositories(t), Permissions: &voiceMediaFixtureProviders{}}
}
func expectPersonalMessagingPanic(t *testing.T, deps personalMessagingDependencies, want string) {
	t.Helper()
	var caught any
	func() { defer func() { caught = recover() }(); initPersonalMessagingServices(deps) }()
	if fmt.Sprint(caught) != want {
		t.Fatalf("panic=%v want %s", caught, want)
	}
}
func TestPersonalMessagingRejectsMissingIntegration(t *testing.T) {
	base := personalMessagingFixture(t)
	for _, field := range []string{"Repositories", "Permissions"} {
		t.Run(field, func(t *testing.T) {
			deps := base
			v := reflect.ValueOf(&deps).Elem().FieldByName(field)
			v.Set(reflect.Zero(v.Type()))
			expectPersonalMessagingPanic(t, deps, "personal messaging requires "+field)
		})
	}
	deps := base
	v := reflect.ValueOf(&deps.Permissions).Elem()
	v.Set(reflect.Zero(v.Elem().Type()))
	expectPersonalMessagingPanic(t, deps, "personal messaging requires Permissions")
}
func TestPersonalMessagingRejectsMissingRepository(t *testing.T) {
	base := personalMessagingFixture(t)
	for _, field := range []string{"Saved", "Message", "Channel", "DM", "Reminder", "UserNote", "User", "Preferences", "Server", "Friendship"} {
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
				expectPersonalMessagingPanic(t, deps, "personal messaging requires repository "+field)
			})
		}
	}
}
func TestPersonalMessagingValidCompositionRetainsOwners(t *testing.T) {
	group := initPersonalMessagingServices(personalMessagingFixture(t))
	if group.Saved == nil || group.Reminder == nil || group.UserNote == nil || group.Personalization == nil {
		t.Fatal("missing personal messaging owner")
	}
}
