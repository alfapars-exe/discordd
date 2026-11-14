package main

import (
	"fmt"
	"github.com/argeinfina/hichat/config"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
	"reflect"
	"testing"
)

func socialMessagingFixture(t *testing.T) socialMessagingDependencies {
	db, repos := startupServiceDependencies(t)
	hub := ws.NewHub()
	return socialMessagingDependencies{Database: db, Repositories: repos, Hub: hub, Config: &config.Config{}, Activity: &membershipFixtureProviders{}, Privacy: initPrivacyPolicies(repos, hub)}
}
func expectSocialPanic(t *testing.T, deps socialMessagingDependencies, want string) {
	t.Helper()
	var caught any
	func() { defer func() { caught = recover() }(); initSocialMessagingServices(deps) }()
	if fmt.Sprint(caught) != want {
		t.Fatalf("panic=%v want %s", caught, want)
	}
}
func TestSocialMessagingRejectsMissingIntegration(t *testing.T) {
	base := socialMessagingFixture(t)
	for _, field := range []string{"Database", "Repositories", "Hub", "Config", "Activity"} {
		t.Run(field, func(t *testing.T) {
			deps := base
			v := reflect.ValueOf(&deps).Elem().FieldByName(field)
			v.Set(reflect.Zero(v.Type()))
			expectSocialPanic(t, deps, "social messaging requires "+field)
		})
	}
}
func TestSocialMessagingRejectsMissingPolicy(t *testing.T) {
	base := socialMessagingFixture(t)
	for _, field := range []string{"ServerDM", "FriendRequests"} {
		t.Run(field, func(t *testing.T) {
			deps := base
			v := reflect.ValueOf(&deps.Privacy).Elem().FieldByName(field)
			v.Set(reflect.Zero(v.Type()))
			expectSocialPanic(t, deps, "social messaging requires policy "+field)
		})
	}
	deps := base
	deps.Privacy.FriendGraph.reader = nil
	expectSocialPanic(t, deps, "social messaging requires policy FriendGraph")
}

type nilSocialEmail struct {
	services.ScheduledEmailEnqueuer
}

func TestSocialMessagingRejectsTypedNilEmail(t *testing.T) {
	deps := socialMessagingFixture(t)
	var provider *nilSocialEmail
	deps.Email = provider
	expectSocialPanic(t, deps, "social messaging email provider is typed nil")
}
func TestSocialMessagingDisabledEmailAndDeliveryRetainOwners(t *testing.T) {
	group := initSocialMessagingServices(socialMessagingFixture(t))
	for _, name := range []string{"Block", "DMSettings", "Notification", "Emoji", "DM", "Friendship", "GroupDM", "DMUpload", "GroupDMUpload"} {
		if reflect.ValueOf(group).FieldByName(name).IsNil() {
			t.Fatalf("missing owner %s", name)
		}
	}
}

func TestSocialMessagingRejectsTypedNilRequiredIntegration(t *testing.T) {
	base := socialMessagingFixture(t)
	for _, field := range []string{"Hub", "Activity"} {
		t.Run(field, func(t *testing.T) {
			deps := base
			v := reflect.ValueOf(&deps).Elem().FieldByName(field)
			v.Set(reflect.Zero(v.Elem().Type()))
			expectSocialPanic(t, deps, "social messaging requires "+field)
		})
	}
}
