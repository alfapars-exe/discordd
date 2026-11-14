package main

import (
	"fmt"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
	"reflect"
	"testing"
)

type membershipFixtureProviders struct {
	services.GameActivityPrivacyInvalidator
	services.ProfileAudienceInvalidator
	services.InviteService
	services.AuditWriter
	services.PermissionInvalidator
	services.ProfileUpdateNotifier
}
type membershipFixtureVoice struct{}

func (*membershipFixtureVoice) DisconnectUser(string)                 {}
func (*membershipFixtureVoice) DisconnectServerMember(string, string) {}
func membershipFixtureDependencies(t *testing.T) membershipDependencies {
	db, repos := startupServiceDependencies(t)
	providers := &membershipFixtureProviders{}
	return membershipDependencies{Database: db, Repositories: repos, Hub: ws.NewHub(), Voice: &membershipFixtureVoice{}, Activity: providers, Profiles: providers, Invites: providers, Audit: providers, UserCache: providers, Permissions: providers, ProfileUpdates: providers}
}
func TestMembershipCompositionRejectsMissingDependencies(t *testing.T) {
	base := membershipFixtureDependencies(t)
	for _, field := range []string{"Database", "Repositories", "Hub", "Voice", "Activity", "Profiles", "Invites", "Audit", "UserCache", "Permissions", "ProfileUpdates"} {
		t.Run(field, func(t *testing.T) {
			deps := base
			value := reflect.ValueOf(&deps).Elem().FieldByName(field)
			value.Set(reflect.Zero(value.Type()))
			var caught any
			func() { defer func() { caught = recover() }(); initMembershipServices(deps) }()
			if fmt.Sprint(caught) != "membership requires "+field {
				t.Fatalf("panic=%v want missing %s", caught, field)
			}
		})
	}
}
func TestMembershipCompositionRejectsTypedNilVoice(t *testing.T) {
	deps := membershipFixtureDependencies(t)
	var voice *membershipFixtureVoice
	deps.Voice = voice
	var caught any
	func() { defer func() { caught = recover() }(); initMembershipServices(deps) }()
	if fmt.Sprint(caught) != "membership requires Voice" {
		t.Fatalf("typed nil voice accepted: %v", caught)
	}
}

func TestMembershipCompositionReturnsAllDeclaredOwners(t *testing.T) {
	group := initMembershipServices(membershipFixtureDependencies(t))
	if group.Members == nil || group.Roles == nil || group.Servers == nil {
		t.Fatalf("incomplete membership group: %+v", group)
	}
}
