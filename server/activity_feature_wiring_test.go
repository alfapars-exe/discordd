package main

import (
	"fmt"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
	"reflect"
	"testing"
)

type activityFeatureFixtureProviders struct {
	services.ChannelPermResolver
	services.FreshChannelPermResolver
	activityFeatureVoice
	services.AppLogService
}

func activityFeatureFixture(t *testing.T) activityFeatureDependencies {
	repos := startupPolicyRepositories(t)
	hub := ws.NewHub()
	privacy := initPrivacyPolicies(repos, hub)
	providers := &activityFeatureFixtureProviders{}
	return activityFeatureDependencies{Repositories: repos, Hub: hub, Profiles: privacy.Profile, Policy: privacy.GameActivity, Activity: services.NewGameActivityService(privacy.GameActivity, repos.Friendship, repos.Server, hub, hub.GameActivityEpoch()), Permissions: providers, FreshPermissions: providers, Voice: providers, Logger: providers}
}
func expectActivityFeaturePanic(t *testing.T, deps activityFeatureDependencies, want string) {
	t.Helper()
	var caught any
	func() { defer func() { caught = recover() }(); initActivityFeatureServices(deps) }()
	if fmt.Sprint(caught) != want {
		t.Fatalf("panic=%v want %s", caught, want)
	}
}
func TestActivityFeaturesRejectMissingIntegration(t *testing.T) {
	base := activityFeatureFixture(t)
	for _, field := range []string{"Repositories", "Hub", "Profiles", "Activity", "Policy", "Permissions", "FreshPermissions", "Voice", "Logger"} {
		t.Run(field, func(t *testing.T) {
			deps := base
			v := reflect.ValueOf(&deps).Elem().FieldByName(field)
			v.Set(reflect.Zero(v.Type()))
			expectActivityFeaturePanic(t, deps, "activity features requires "+field)
		})
	}
	for _, field := range []string{"Hub", "Profiles", "Policy", "Permissions", "FreshPermissions", "Voice", "Logger"} {
		t.Run("typed nil "+field, func(t *testing.T) {
			deps := base
			v := reflect.ValueOf(&deps).Elem().FieldByName(field)
			v.Set(reflect.Zero(v.Elem().Type()))
			expectActivityFeaturePanic(t, deps, "activity features requires "+field)
		})
	}
}
func TestActivityFeaturesRejectMissingRepository(t *testing.T) {
	base := activityFeatureFixture(t)
	for _, field := range []string{"Preferences", "Friendship", "User", "AccountLifecycle", "Server", "Ban", "Channel"} {
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
				expectActivityFeaturePanic(t, deps, "activity features requires repository "+field)
			})
		}
	}
}
func TestActivityFeaturesValidCompositionRetainsOwners(t *testing.T) {
	group := initActivityFeatureServices(activityFeatureFixture(t))
	if group.Preferences == nil || group.GameJoin == nil || group.ClipRecording == nil {
		t.Fatal("missing activity feature owner")
	}
}
