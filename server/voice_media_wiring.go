package main

import (
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
)

// initVoiceMediaServices owns the mutually dependent voice hooks as one
// composition step. Both bindings finish before request handling starts.
// The remaining setter cycle is explicit here, not a completed constructor
// dependency migration.
func initVoiceMediaServices(repos *Repositories, hub ws.Broadcaster,
	permissions services.ChannelPermResolver, voice services.VoiceRuntime,
	uploadDir string, encryptionKey []byte, logger services.VoiceAppLogger,
) (services.EntranceService, services.MusicBotRuntime) {
	entrance := services.NewEntranceService(repos.Entrance, repos.Server, repos.Role, repos.Channel,
		permissions, hub, voice, uploadDir)
	voice.SetEntranceHook(entrance)
	music := services.NewMusicBotService(repos.Channel, repos.LiveKit, permissions, hub, repos.User,
		encryptionKey, logger, repos.MusicSession, voice,
		services.MusicAudienceDependencies{Voice: voice, Members: repos.Server})
	voice.SetMusicBotHook(music)
	return entrance, music
}
