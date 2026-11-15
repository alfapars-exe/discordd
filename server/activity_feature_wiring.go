package main

import (
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
)

type activityFeatureHub interface {
	ws.Broadcaster
	services.GameJoinConnectionGate
}
type activityFeatureVoice interface {
	services.GameJoinVoiceAdmission
	services.MusicAudienceVoice
}
type activityFeatureDependencies struct {
	Repositories     *Repositories
	Hub              activityFeatureHub
	Profiles         services.ProfileAudienceInvalidator
	Activity         *services.GameActivityService
	Policy           services.GameActivityPrivacyPolicy
	Permissions      services.ChannelPermResolver
	FreshPermissions services.FreshChannelPermResolver
	Voice            activityFeatureVoice
	Logger           services.AppLogService
}
type activityFeatureServices struct {
	Preferences   services.PreferencesService
	GameJoin      *services.GameJoinService
	ClipRecording services.ClipRecordingService
}

// initActivityFeatureServices shares privacy changes, game admission and clip
// consent providers. Callback registration remains explicit in the caller.
func initActivityFeatureServices(deps activityFeatureDependencies) activityFeatureServices {
	repos := deps.Repositories
	preferences := services.NewPreferencesService(repos.Preferences, deps.Profiles, deps.Activity, deps.Hub)
	policy := services.NewGameJoinPolicy(deps.Policy, repos.Preferences, repos.Friendship, repos.User, repos.AccountLifecycle, repos.Server, repos.Ban, repos.Channel, deps.Permissions, deps.Voice, deps.FreshPermissions)
	join := services.NewGameJoinService(deps.Activity, policy, deps.Hub)
	clips := services.NewClipRecordingService(deps.Voice, repos.Preferences, deps.Logger)
	return activityFeatureServices{Preferences: preferences, GameJoin: join, ClipRecording: clips}
}
