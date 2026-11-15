package main

import (
	"github.com/argeinfina/hichat/config"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
)

type voiceRuntimeHub interface {
	ws.BroadcastAndOnline
	services.OnlineUserChecker
	services.VoiceFanoutOnlineUsers
}
type voiceRuntimeDependencies struct {
	Repositories  *Repositories
	Hub           voiceRuntimeHub
	Permissions   services.ChannelPermissionRuntime
	Audit         services.AuditWriter
	Logger        services.VoiceAppLogger
	Config        *config.Config
	EncryptionKey []byte
}
type voiceRuntimeServices struct {
	Voice    services.VoiceRuntime
	Entrance services.EntranceService
	Music    services.MusicBotRuntime
}

// initVoiceRuntimeServices installs mutually dependent media hooks before voice
// allocates its fanout worker; runtime shutdown remains owned by the caller.
func initVoiceRuntimeServices(deps voiceRuntimeDependencies) voiceRuntimeServices {
	repos, permissions, hub := deps.Repositories, deps.Permissions, deps.Hub
	var group voiceRuntimeServices
	group.Voice = services.NewVoiceService(repos.Channel, repos.LiveKit, permissions, hub, hub, repos.Server, deps.EncryptionKey, repos.MemberTimeout, repos.Ban, deps.Audit,
		services.VoiceRuntimeDependencies{
			Fanout:                  services.VoiceFanoutDependencies{Online: hub, Members: repos.Server},
			PermissionInvalidations: permissions, UsageCredit: services.NewDurableVoiceUsageCredit(repos.LiveKit), UsageRecovery: repos.LiveKit,
			VoiceAccess: repos.VoiceAccess, FreshPermissions: permissions, AppLogger: deps.Logger,
			Integrations: func(voice services.VoiceService) (services.VoiceEntranceHook, services.MusicBotChannelHook) {
				group.Entrance, group.Music = initVoiceMediaServices(voiceMediaDependencies{Repositories: repos, Hub: hub, Permissions: permissions, FreshPermissions: permissions, Voice: voice, UploadDir: deps.Config.Upload.Dir, EncryptionKey: deps.EncryptionKey, Logger: deps.Logger})
				return group.Entrance, group.Music
			},
		})
	return group
}
