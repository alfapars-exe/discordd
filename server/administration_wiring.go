package main

import (
	"database/sql"
	"github.com/argeinfina/hichat/config"
	"github.com/argeinfina/hichat/pkg/email"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
)

type administrationVoice interface {
	services.VoiceDisconnecter
	services.ActiveVoiceProvider
}
type administrationDependencies struct {
	Database      *sql.DB
	Repositories  *Repositories
	Hub           ws.EventPublisher
	Voice         administrationVoice
	Email         email.EmailSender
	UserCache     services.UserCacheInvalidator
	Config        *config.Config
	EncryptionKey []byte
}
type administrationServices struct {
	User    services.AdminUserService
	Server  services.AdminServerService
	LiveKit services.LiveKitAdminService
}

// initAdministrationServices shares account invalidation, voice revocation and
// configured administrative integrations without starting background workers.
func initAdministrationServices(deps administrationDependencies) administrationServices {
	repos, cfg := deps.Repositories, deps.Config
	user := services.NewAdminUserService(repos.User, deps.Hub, deps.Voice, deps.Email, deps.UserCache)
	user.SetUploadDir(cfg.Upload.Dir)
	server := services.NewAdminServerService(deps.Database, repos.Server, repos.User, deps.Hub, deps.Email)
	server.SetUploadDir(cfg.Upload.Dir)
	livekit := services.NewLiveKitAdminService(repos.LiveKit, repos.Server, repos.User, repos.Channel, deps.Voice, deps.EncryptionKey, cfg.HetznerAPIToken, cfg.AllowLiveKitInstanceCreation)
	return administrationServices{User: user, Server: server, LiveKit: livekit}
}
