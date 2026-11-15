package main

import (
	"fmt"
	"github.com/argeinfina/hichat/config"
	"github.com/argeinfina/hichat/pkg/email"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
	"reflect"
	"testing"
)

type administrationFixtureProviders struct {
	administrationVoice
	services.UserCacheInvalidator
}
type nilAdministrationEmail struct{ email.EmailSender }

func administrationFixture(t *testing.T) administrationDependencies {
	db, repos := startupServiceDependencies(t)
	providers := &administrationFixtureProviders{}
	return administrationDependencies{Database: db, Repositories: repos, Hub: ws.NewHub(), Voice: providers, UserCache: providers, Config: &config.Config{}}
}
func expectAdministrationPanic(t *testing.T, deps administrationDependencies, want string) {
	t.Helper()
	var caught any
	func() { defer func() { caught = recover() }(); initAdministrationServices(deps) }()
	if fmt.Sprint(caught) != want {
		t.Fatalf("panic=%v want %s", caught, want)
	}
}
func TestAdministrationRejectsMissingIntegration(t *testing.T) {
	base := administrationFixture(t)
	for _, field := range []string{"Database", "Repositories", "Hub", "Voice", "UserCache", "Config"} {
		t.Run(field, func(t *testing.T) {
			deps := base
			v := reflect.ValueOf(&deps).Elem().FieldByName(field)
			v.Set(reflect.Zero(v.Type()))
			expectAdministrationPanic(t, deps, "administration requires "+field)
		})
	}
	for _, field := range []string{"Hub", "Voice", "UserCache"} {
		t.Run("typed nil "+field, func(t *testing.T) {
			deps := base
			v := reflect.ValueOf(&deps).Elem().FieldByName(field)
			v.Set(reflect.Zero(v.Elem().Type()))
			expectAdministrationPanic(t, deps, "administration requires "+field)
		})
	}
}
func TestAdministrationRejectsMissingRepository(t *testing.T) {
	base := administrationFixture(t)
	for _, field := range []string{"User", "Server", "LiveKit", "Channel"} {
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
				expectAdministrationPanic(t, deps, "administration requires repository "+field)
			})
		}
	}
}
func TestAdministrationRejectsTypedNilEmail(t *testing.T) {
	deps := administrationFixture(t)
	var provider *nilAdministrationEmail
	deps.Email = provider
	expectAdministrationPanic(t, deps, "administration email provider is typed nil")
}
func TestAdministrationDisabledEmailRetainsOwners(t *testing.T) {
	group := initAdministrationServices(administrationFixture(t))
	if group.User == nil || group.Server == nil || group.LiveKit == nil {
		t.Fatal("missing administration owner")
	}
}
