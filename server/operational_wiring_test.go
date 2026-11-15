package main

import (
	"fmt"
	"github.com/argeinfina/hichat/config"
	"github.com/argeinfina/hichat/services"
	"reflect"
	"testing"
)

type operationalFixtureProviders struct{ services.ScreenShareCounter }
type nilOperationalReadiness struct {
	services.LiveKitReachabilityReporter
}

func operationalFixture(t *testing.T) operationalDependencies {
	return operationalDependencies{Repositories: startupPolicyRepositories(t), Config: &config.Config{}, ScreenShares: &operationalFixtureProviders{}}
}
func expectOperationalPanic(t *testing.T, deps operationalDependencies, want string) {
	t.Helper()
	var caught any
	func() {
		defer func() { caught = recover() }()
		group := initOperationalServices(deps)
		group.Collector.Stop()
	}()
	if fmt.Sprint(caught) != want {
		t.Fatalf("panic=%v want %s", caught, want)
	}
}
func TestOperationalRejectsMissingIntegration(t *testing.T) {
	base := operationalFixture(t)
	for _, field := range []string{"Repositories", "Config", "ScreenShares"} {
		t.Run(field, func(t *testing.T) {
			deps := base
			v := reflect.ValueOf(&deps).Elem().FieldByName(field)
			v.Set(reflect.Zero(v.Type()))
			expectOperationalPanic(t, deps, "operations requires "+field)
		})
	}
	deps := base
	var provider *operationalFixtureProviders
	deps.ScreenShares = provider
	expectOperationalPanic(t, deps, "operations requires ScreenShares")
}
func TestOperationalRejectsMissingRepository(t *testing.T) {
	base := operationalFixture(t)
	for _, field := range []string{"MetricsHistory", "LiveKit", "Feedback"} {
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
				expectOperationalPanic(t, deps, "operations requires repository "+field)
			})
		}
	}
}
func TestOperationalRejectsTypedNilReadiness(t *testing.T) {
	deps := operationalFixture(t)
	var provider *nilOperationalReadiness
	deps.Reachability = provider
	expectOperationalPanic(t, deps, "operations readiness provider is typed nil")
}
func TestOperationalDisabledReadinessRetainsOwners(t *testing.T) {
	group := initOperationalServices(operationalFixture(t))
	t.Cleanup(group.Collector.Stop)
	if group.History == nil || group.Feedback == nil || group.FeedbackUpload == nil || group.Collector == nil {
		t.Fatal("missing operational owner")
	}
	group.Collector.Stop()
	group.Collector.Stop()
}
