package main

import (
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
)

type voiceMediaDependencies struct {
	Repositories     *Repositories
	Hub              ws.Broadcaster
	Permissions      services.ChannelPermResolver
	FreshPermissions services.MusicAudienceFreshPermissions
	Voice            services.VoiceService
	UploadDir        string
	EncryptionKey    []byte
	Logger           services.VoiceAppLogger
}

// initVoiceMediaServices binds media hooks before voice allocates its workers.
func initVoiceMediaServices(deps voiceMediaDependencies) (services.EntranceService, services.MusicBotRuntime) {
	for _, input := range []struct {
		name  string
		value any
	}{
		{"Repositories", deps.Repositories}, {"Hub", deps.Hub}, {"Permissions", deps.Permissions},
		{"FreshPermissions", deps.FreshPermissions}, {"Voice", deps.Voice}, {"Logger", deps.Logger},
	} {
		if missingCompositionInput(input.value) {
			panic("voice media requires " + input.name)
		}
	}
	for _, input := range []struct {
		name  string
		value any
	}{
		{"Entrance", deps.Repositories.Entrance}, {"Server", deps.Repositories.Server}, {"Role", deps.Repositories.Role},
		{"Channel", deps.Repositories.Channel}, {"LiveKit", deps.Repositories.LiveKit}, {"User", deps.Repositories.User}, {"MusicSession", deps.Repositories.MusicSession},
	} {
		if missingCompositionInput(input.value) {
			panic("voice media requires repository " + input.name)
		}
	}
	repos, hub, permissions, fresh, voice := deps.Repositories, deps.Hub, deps.Permissions, deps.FreshPermissions, deps.Voice
	uploadDir, encryptionKey, logger := deps.UploadDir, deps.EncryptionKey, deps.Logger
	entrance := services.NewEntranceService(repos.Entrance, repos.Server, repos.Role, repos.Channel,
		permissions, hub, voice, uploadDir)
	music := services.NewMusicBotService(repos.Channel,
		repos.LiveKit,
		permissions,
		hub,
		repos.User,
		encryptionKey,
		logger,
		services.MusicPersistenceDependencies{Sessions: repos.MusicSession, RequesterPrivacy: repos.MusicSession, LegacyEnqueue: repos.MusicSession, Control: repos.MusicSession},
		voice,
		services.MusicAudienceDependencies{Voice: voice, Members: repos.Server, FreshPermissions: fresh})
	return entrance, music
}
