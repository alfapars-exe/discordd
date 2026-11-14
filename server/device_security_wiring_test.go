package main

import (
	"fmt"
	"github.com/argeinfina/hichat/ws"
	"reflect"
	"testing"
)

func deviceSecurityFixture(t *testing.T) deviceSecurityDependencies {
	db, repos := startupServiceDependencies(t)
	return deviceSecurityDependencies{Database: db, Repositories: repos, Hub: ws.NewHub(), Permissions: &voiceMediaFixtureProviders{}}
}
func expectDeviceSecurityPanic(t *testing.T, deps deviceSecurityDependencies, want string) {
	t.Helper()
	var caught any
	func() { defer func() { caught = recover() }(); initDeviceSecurityServices(deps) }()
	if fmt.Sprint(caught) != want {
		t.Fatalf("panic=%v want %s", caught, want)
	}
}
func TestDeviceSecurityRejectsMissingIntegration(t *testing.T) {
	base := deviceSecurityFixture(t)
	for _, field := range []string{"Database", "Repositories", "Hub", "Permissions"} {
		t.Run(field, func(t *testing.T) {
			deps := base
			v := reflect.ValueOf(&deps).Elem().FieldByName(field)
			v.Set(reflect.Zero(v.Type()))
			expectDeviceSecurityPanic(t, deps, "device security requires "+field)
		})
	}
	for _, field := range []string{"Hub", "Permissions"} {
		t.Run("typed nil "+field, func(t *testing.T) {
			deps := base
			v := reflect.ValueOf(&deps).Elem().FieldByName(field)
			v.Set(reflect.Zero(v.Elem().Type()))
			expectDeviceSecurityPanic(t, deps, "device security requires "+field)
		})
	}
}
func TestDeviceSecurityRejectsMissingRepository(t *testing.T) {
	base := deviceSecurityFixture(t)
	for _, field := range []string{"Device", "Server", "E2EEBackup", "GroupSession", "Channel"} {
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
				expectDeviceSecurityPanic(t, deps, "device security requires repository "+field)
			})
		}
	}
}
func TestDeviceSecurityValidCompositionRetainsOwners(t *testing.T) {
	group := initDeviceSecurityServices(deviceSecurityFixture(t))
	if group.Device == nil || group.E2EE == nil {
		t.Fatal("missing device security owner")
	}
}
