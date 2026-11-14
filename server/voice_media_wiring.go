package main

import (
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
)

// initVoiceMediaServices owns the mutually dependent voice hooks as one
// composition step. The voice constructor installs the returned hooks before
// allocating its workers or exposing the service to request handlers.
func initVoiceMediaServices(repos *Repositories, hub ws.Broadcaster,
	permissions services.ChannelPermResolver, voice services.VoiceService,
	uploadDir string, encryptionKey []byte, logger services.VoiceAppLogger,
) (services.EntranceService, services.MusicBotRuntime) {
	entrance := services.NewEntranceService(repos.Entrance, repos.Server, repos.Role, repos.Channel,
		permissions, hub, voice, uploadDir)
	music := services.NewMusicBotService(repos.Channel, repos.LiveKit, permissions, hub, repos.User,
		encryptionKey, logger, repos.MusicSession, voice,
		services.MusicAudienceDependencies{Voice: voice, Members: repos.Server})
	return entrance, music
}
