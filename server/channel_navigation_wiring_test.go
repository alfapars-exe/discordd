package main

import (
	"fmt"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
	"reflect"
	"testing"
)

type channelNavigationFixtureProviders struct {
	channelNavigationPermissions
	services.FreshChannelPermResolver
	services.VoiceChannelDeletionHandler
	services.AuditWriter
}

func channelNavigationFixture(t *testing.T) channelNavigationDependencies {
	providers := &channelNavigationFixtureProviders{}
	return channelNavigationDependencies{Repositories: startupPolicyRepositories(t), Hub: ws.NewHub(), Permissions: providers, FreshPermissions: providers, VoiceDeletion: providers, Audit: providers}
}
func expectChannelNavigationPanic(t *testing.T, deps channelNavigationDependencies, want string) {
	t.Helper()
	var caught any
	func() { defer func() { caught = recover() }(); initChannelNavigationServices(deps) }()
	if fmt.Sprint(caught) != want {
		t.Fatalf("panic=%v want %s", caught, want)
	}
}
func TestChannelNavigationRejectsMissingIntegration(t *testing.T) {
	base := channelNavigationFixture(t)
	for _, field := range []string{"Repositories", "Hub", "Permissions", "FreshPermissions", "VoiceDeletion", "Audit"} {
		t.Run(field, func(t *testing.T) {
			deps := base
			v := reflect.ValueOf(&deps).Elem().FieldByName(field)
			v.Set(reflect.Zero(v.Type()))
			expectChannelNavigationPanic(t, deps, "channel navigation requires "+field)
		})
	}
	for _, field := range []string{"Hub", "Permissions", "FreshPermissions", "VoiceDeletion", "Audit"} {
		t.Run("typed nil "+field, func(t *testing.T) {
			deps := base
			v := reflect.ValueOf(&deps).Elem().FieldByName(field)
			v.Set(reflect.Zero(v.Elem().Type()))
			expectChannelNavigationPanic(t, deps, "channel navigation requires "+field)
		})
	}
}
func TestChannelNavigationRejectsMissingRepository(t *testing.T) {
	base := channelNavigationFixture(t)
	for _, field := range []string{"Channel", "Category", "Notification", "Message", "Pin", "Search", "ReadState"} {
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
				expectChannelNavigationPanic(t, deps, "channel navigation requires repository "+field)
			})
		}
	}
}
func TestChannelNavigationValidCompositionRetainsOwners(t *testing.T) {
	group := initChannelNavigationServices(channelNavigationFixture(t))
	for _, field := range []string{"Channel", "Thread", "Category", "Pin", "Search", "ReadState"} {
		if reflect.ValueOf(group).FieldByName(field).IsNil() {
			t.Fatalf("missing owner %s", field)
		}
	}
}
