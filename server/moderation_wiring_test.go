package main

import (
	"fmt"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
	"reflect"
	"testing"
)

type moderationFixtureProviders struct {
	moderationMessageContextReader
	moderationDMContextReader
	services.EmojiResolver
}

func moderationFixture(t *testing.T) moderationDependencies {
	db, repos := startupServiceDependencies(t)
	providers := &moderationFixtureProviders{}
	return moderationDependencies{Database: db, Repositories: repos, Hub: ws.NewHub(), Permissions: &voiceMediaFixtureProviders{}, Messages: providers, DMs: providers, Emoji: providers}
}
func expectModerationPanic(t *testing.T, deps moderationDependencies, want string) {
	t.Helper()
	var caught any
	func() { defer func() { caught = recover() }(); initModerationServices(deps) }()
	if fmt.Sprint(caught) != want {
		t.Fatalf("panic=%v want %s", caught, want)
	}
}
func TestModerationRejectsMissingIntegration(t *testing.T) {
	base := moderationFixture(t)
	for _, field := range []string{"Database", "Repositories", "Hub", "Permissions", "Messages", "DMs", "Emoji"} {
		t.Run(field, func(t *testing.T) {
			deps := base
			v := reflect.ValueOf(&deps).Elem().FieldByName(field)
			v.Set(reflect.Zero(v.Type()))
			expectModerationPanic(t, deps, "moderation requires "+field)
		})
	}
	for _, field := range []string{"Hub", "Permissions", "Messages", "DMs", "Emoji"} {
		t.Run("typed nil "+field, func(t *testing.T) {
			deps := base
			v := reflect.ValueOf(&deps).Elem().FieldByName(field)
			v.Set(reflect.Zero(v.Elem().Type()))
			expectModerationPanic(t, deps, "moderation requires "+field)
		})
	}
}
func TestModerationRejectsMissingRepository(t *testing.T) {
	base := moderationFixture(t)
	for _, field := range []string{"Message", "Channel", "DM", "GroupDM", "Reaction", "MemberTimeout", "Notification", "Preferences", "User", "Report"} {
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
				expectModerationPanic(t, deps, "moderation requires repository "+field)
			})
		}
	}
}
func TestModerationValidCompositionRetainsOwners(t *testing.T) {
	group := initModerationServices(moderationFixture(t))
	for _, field := range []string{"SpamInbox", "MediaLabel", "Reaction", "Report", "ReportUpload"} {
		if reflect.ValueOf(group).FieldByName(field).IsNil() {
			t.Fatalf("missing owner %s", field)
		}
	}
}
