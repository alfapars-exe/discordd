package main

import (
	"fmt"
	"github.com/argeinfina/hichat/pkg/email"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
	"reflect"
	"testing"
)

type communicationFixtureLogger struct{ services.P2PAppLogger }
type nilCommunicationSender struct{ email.CategorySender }

func communicationFixture(t *testing.T) communicationDependencies {
	return communicationDependencies{Repositories: startupPolicyRepositories(t), Hub: ws.NewHub(), Logger: &communicationFixtureLogger{}}
}
func expectCommunicationPanic(t *testing.T, deps communicationDependencies, want string) {
	t.Helper()
	var caught any
	func() { defer func() { caught = recover() }(); initCommunicationServices(deps) }()
	if fmt.Sprint(caught) != want {
		t.Fatalf("panic=%v want %s", caught, want)
	}
}
func TestCommunicationRejectsMissingIntegration(t *testing.T) {
	base := communicationFixture(t)
	for _, field := range []string{"Repositories", "Hub", "Logger"} {
		t.Run(field, func(t *testing.T) {
			deps := base
			v := reflect.ValueOf(&deps).Elem().FieldByName(field)
			v.Set(reflect.Zero(v.Type()))
			expectCommunicationPanic(t, deps, "communication requires "+field)
		})
	}
	for _, field := range []string{"Hub", "Logger"} {
		t.Run("typed nil "+field, func(t *testing.T) {
			deps := base
			v := reflect.ValueOf(&deps).Elem().FieldByName(field)
			v.Set(reflect.Zero(v.Elem().Type()))
			expectCommunicationPanic(t, deps, "communication requires "+field)
		})
	}
}
func TestCommunicationRejectsMissingRepository(t *testing.T) {
	base := communicationFixture(t)
	for _, field := range []string{"EmailDelivery", "EmailUnsubscribe", "Friendship", "User"} {
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
				expectCommunicationPanic(t, deps, "communication requires repository "+field)
			})
		}
	}
}
func TestCommunicationRejectsTypedNilSender(t *testing.T) {
	deps := communicationFixture(t)
	var provider *nilCommunicationSender
	deps.Sender = provider
	expectCommunicationPanic(t, deps, "communication email sender is typed nil")
}
func TestCommunicationDisabledSenderRetainsOwners(t *testing.T) {
	group := initCommunicationServices(communicationFixture(t))
	if group.EmailDelivery == nil || group.P2PCall == nil {
		t.Fatal("missing communication owner")
	}
}
