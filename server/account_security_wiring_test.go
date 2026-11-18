package main

import (
	"fmt"
	"github.com/argeinfina/hichat/config"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
	"reflect"
	"testing"
)

type accountSecurityFixtureProviders struct {
	services.PermissionInvalidator
	services.AuthAppLogger
	services.MusicRequesterRetirementObserver
}

func accountSecurityFixtureDependencies(t *testing.T) accountSecurityDependencies {
	providers := &accountSecurityFixtureProviders{}
	return accountSecurityDependencies{Repositories: startupPolicyRepositories(t), Hub: ws.NewHub(), Config: &config.Config{}, Voice: &membershipFixtureVoice{}, Permissions: providers, UserCache: providers, Logger: providers, MusicRetirement: providers}
}
func TestAccountSecurityRejectsMissingIntegration(t *testing.T) {
	base := accountSecurityFixtureDependencies(t)
	for _, field := range []string{"Repositories", "Hub", "Config", "Voice", "Permissions", "UserCache", "Logger", "MusicRetirement"} {
		t.Run(field, func(t *testing.T) {
			deps := base
			value := reflect.ValueOf(&deps).Elem().FieldByName(field)
			value.Set(reflect.Zero(value.Type()))
			var caught any
			func() { defer func() { caught = recover() }(); initAccountSecurityServices(deps) }()
			if fmt.Sprint(caught) != "account security requires "+field {
				t.Fatalf("panic=%v want missing %s", caught, field)
			}
		})
	}
}

type nilAccountSecurityEmail struct{ accountSecurityEmail }

func TestAccountSecurityRejectsTypedNilEmail(t *testing.T) {
	deps := accountSecurityFixtureDependencies(t)
	var value *nilAccountSecurityEmail
	deps.Email = value
	var caught any
	func() { defer func() { caught = recover() }(); initAccountSecurityServices(deps) }()
	if fmt.Sprint(caught) != "account security email provider is typed nil" {
		t.Fatalf("typed nil email accepted: %v", caught)
	}
}
func TestAccountSecurityDisabledEmailRetainsOwners(t *testing.T) {
	group := initAccountSecurityServices(accountSecurityFixtureDependencies(t))
	if group.Auth == nil || group.MFA == nil || group.EmailVerification == nil {
		t.Fatal("disabled email removed security owners")
	}
}

func TestAccountSecurityRejectsMissingRepositories(t *testing.T) {
	base := accountSecurityFixtureDependencies(t)
	for _, field := range []string{"User", "Session", "ResetToken", "MFA", "EmailVerification", "AuthSession", "AccountLifecycle", "AccountAnonymization", "ApplicationRemoval", "ServerOwnership"} {
		t.Run(field, func(t *testing.T) {
			deps := base
			repos := *base.Repositories
			deps.Repositories = &repos
			value := reflect.ValueOf(&repos).Elem().FieldByName(field)
			value.Set(reflect.Zero(value.Type()))
			var caught any
			func() { defer func() { caught = recover() }(); initAccountSecurityServices(deps) }()
			if fmt.Sprint(caught) != "account security requires repository "+field {
				t.Fatalf("panic=%v want missing %s", caught, field)
			}
		})
	}
}

type nilAccountSessionStore struct {
	repository.AuthSessionRepository
}

func TestAccountSecurityRejectsTypedNilSessionStore(t *testing.T) {
	deps := accountSecurityFixtureDependencies(t)
	var value *nilAccountSessionStore
	deps.Repositories.AuthSession = value
	var caught any
	func() { defer func() { caught = recover() }(); initAccountSecurityServices(deps) }()
	if fmt.Sprint(caught) != "account security requires repository AuthSession" {
		t.Fatalf("typed nil session accepted: %v", caught)
	}
}
