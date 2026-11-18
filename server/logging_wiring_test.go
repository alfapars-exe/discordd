package main

import (
	"fmt"
	"github.com/argeinfina/hichat/ws"
	"reflect"
	"testing"
)

func loggingFixture(t *testing.T) loggingDependencies {
	return loggingDependencies{Repositories: startupPolicyRepositories(t), Hub: ws.NewHub()}
}
func expectLoggingPanic(t *testing.T, deps loggingDependencies, want string) {
	t.Helper()
	var caught any
	func() { defer func() { caught = recover() }(); initLoggingServices(deps) }()
	if fmt.Sprint(caught) != want {
		t.Fatalf("panic=%v want %s", caught, want)
	}
}
func TestLoggingRejectsMissingIntegration(t *testing.T) {
	base := loggingFixture(t)
	for _, field := range []string{"Repositories", "Hub"} {
		t.Run(field, func(t *testing.T) {
			deps := base
			v := reflect.ValueOf(&deps).Elem().FieldByName(field)
			v.Set(reflect.Zero(v.Type()))
			expectLoggingPanic(t, deps, "logging requires "+field)
		})
	}
	deps := base
	var hub *ws.Hub
	deps.Hub = hub
	expectLoggingPanic(t, deps, "logging requires Hub")
}
func TestLoggingRejectsMissingRepository(t *testing.T) {
	base := loggingFixture(t)
	for _, field := range []string{"AuditLog", "User", "Role", "AppLog"} {
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
				expectLoggingPanic(t, deps, "logging requires repository "+field)
			})
		}
	}
}
func TestLoggingValidOwnersStopWithoutStart(t *testing.T) {
	group := initLoggingServices(loggingFixture(t))
	if group.Audit == nil || group.App == nil {
		t.Fatal("missing logging owner")
	}
	group.Audit.Stop()
	group.App.Stop()
	group.Audit.Stop()
	group.App.Stop()
}
