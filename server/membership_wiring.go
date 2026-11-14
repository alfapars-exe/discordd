package main

import (
	"database/sql"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
)

type membershipVoice interface {
	services.VoiceDisconnecter
	DisconnectServerMember(string, string)
}
type membershipDependencies struct {
	Database       *sql.DB
	Repositories   *Repositories
	Hub            ws.BroadcastAndManage
	Voice          membershipVoice
	Activity       services.GameActivityPrivacyInvalidator
	Profiles       services.ProfileAudienceInvalidator
	Invites        services.InviteService
	Audit          services.AuditWriter
	UserCache      services.UserCacheInvalidator
	Permissions    services.PermissionInvalidator
	ProfileUpdates services.ProfileUpdateNotifier
	UploadDir      string
	EncryptionKey  []byte
}
type membershipServices struct {
	Members services.MemberService
	Roles   services.RoleService
	Servers services.ServerService
}

// initMembershipServices shares one transaction coordinator across membership and role writes.
func initMembershipServices(deps membershipDependencies) membershipServices {
	for _, input := range []struct {
		name  string
		value any
	}{
		{"Database", deps.Database}, {"Repositories", deps.Repositories}, {"Hub", deps.Hub}, {"Voice", deps.Voice},
		{"Activity", deps.Activity}, {"Profiles", deps.Profiles}, {"Invites", deps.Invites}, {"Audit", deps.Audit},
		{"UserCache", deps.UserCache}, {"Permissions", deps.Permissions}, {"ProfileUpdates", deps.ProfileUpdates},
	} {
		if missingCompositionInput(input.value) {
			panic("membership requires " + input.name)
		}
	}
	repos := deps.Repositories
	for _, input := range []struct {
		name  string
		value any
	}{
		{"Preferences", repos.Preferences}, {"User", repos.User}, {"Role", repos.Role}, {"Ban", repos.Ban},
		{"MemberTimeout", repos.MemberTimeout}, {"Server", repos.Server}, {"LiveKit", repos.LiveKit}, {"Channel", repos.Channel}, {"Category", repos.Category},
	} {
		if missingCompositionInput(input.value) {
			panic("membership requires repository " + input.name)
		}
	}
	transactions := repository.NewServerMembershipTxRunner(deps.Database)
	members := services.NewMemberService(deps.Activity, deps.Profiles, repos.User, repos.Role, repos.Ban, repos.MemberTimeout, repos.Server, transactions, deps.Hub, deps.Voice, deps.Audit, deps.UserCache, deps.Permissions, deps.ProfileUpdates)
	roles := services.NewRoleService(repos.Role, transactions, deps.Hub, deps.Audit, deps.Permissions)
	servers := services.NewServerService(repos.Preferences, deps.Activity, deps.Database, repos.Server, repos.LiveKit, repos.Role, repos.Channel, repos.Category, repos.User, repos.Ban, deps.Invites, deps.Hub, deps.EncryptionKey, deps.Audit, deps.Voice.DisconnectServerMember, transactions, deps.Permissions, repos.Server)
	servers.SetUploadDir(deps.UploadDir)
	return membershipServices{Members: members, Roles: roles, Servers: servers}
}
