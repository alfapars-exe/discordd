package main

import (
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
	"reflect"
	"testing"
)

type hubRegistrationRecorder struct {
	*ws.Hub
	callbacks map[string][]any
}

func (r *hubRegistrationRecorder) OnUserFirstConnect(cb ws.UserConnectionCallback) {
	r.callbacks["OnUserFirstConnect"] = append(r.callbacks["OnUserFirstConnect"], cb)
}
func (r *hubRegistrationRecorder) OnUserFullyDisconnected(cb ws.UserConnectionCallback) {
	r.callbacks["OnUserFullyDisconnected"] = append(r.callbacks["OnUserFullyDisconnected"], cb)
}
func (r *hubRegistrationRecorder) OnGameActivitySnapshot(cb ws.GameActivitySnapshotCallback) {
	r.callbacks["OnGameActivitySnapshot"] = append(r.callbacks["OnGameActivitySnapshot"], cb)
}
func (r *hubRegistrationRecorder) OnGameActivityConnect(cb ws.GameActivityConnectionCallback) {
	r.callbacks["OnGameActivityConnect"] = append(r.callbacks["OnGameActivityConnect"], cb)
}
func (r *hubRegistrationRecorder) OnGameActivityPresenceChange(cb ws.GameActivitySnapshotCallback) {
	r.callbacks["OnGameActivityPresenceChange"] = append(r.callbacks["OnGameActivityPresenceChange"], cb)
}
func (r *hubRegistrationRecorder) OnGameActivityDisconnect(cb ws.GameActivityConnectionCallback) {
	r.callbacks["OnGameActivityDisconnect"] = append(r.callbacks["OnGameActivityDisconnect"], cb)
}
func (r *hubRegistrationRecorder) OnGameActivityUpdate(cb ws.GameActivityUpdateCallback) {
	r.callbacks["OnGameActivityUpdate"] = append(r.callbacks["OnGameActivityUpdate"], cb)
}
func (r *hubRegistrationRecorder) OnPresenceManualUpdate(cb ws.PresenceManualUpdateCallback) {
	r.callbacks["OnPresenceManualUpdate"] = append(r.callbacks["OnPresenceManualUpdate"], cb)
}
func (r *hubRegistrationRecorder) OnVoiceJoin(cb ws.VoiceJoinCallback) {
	r.callbacks["OnVoiceJoin"] = append(r.callbacks["OnVoiceJoin"], cb)
}
func (r *hubRegistrationRecorder) OnVoiceLeave(cb ws.VoiceLeaveCallback) {
	r.callbacks["OnVoiceLeave"] = append(r.callbacks["OnVoiceLeave"], cb)
}
func (r *hubRegistrationRecorder) OnVoiceStateUpdate(cb ws.VoiceStateUpdateCallback) {
	r.callbacks["OnVoiceStateUpdate"] = append(r.callbacks["OnVoiceStateUpdate"], cb)
}
func (r *hubRegistrationRecorder) OnVoiceAdminStateUpdate(cb ws.VoiceAdminStateUpdateCallback) {
	r.callbacks["OnVoiceAdminStateUpdate"] = append(r.callbacks["OnVoiceAdminStateUpdate"], cb)
}
func (r *hubRegistrationRecorder) OnVoiceMoveUser(cb ws.VoiceMoveUserCallback) {
	r.callbacks["OnVoiceMoveUser"] = append(r.callbacks["OnVoiceMoveUser"], cb)
}
func (r *hubRegistrationRecorder) OnVoiceDisconnectUser(cb ws.VoiceDisconnectUserCallback) {
	r.callbacks["OnVoiceDisconnectUser"] = append(r.callbacks["OnVoiceDisconnectUser"], cb)
}
func (r *hubRegistrationRecorder) OnVoiceActivity(cb ws.VoiceActivityCallback) {
	r.callbacks["OnVoiceActivity"] = append(r.callbacks["OnVoiceActivity"], cb)
}
func (r *hubRegistrationRecorder) OnP2PCallInitiate(cb ws.P2PCallInitiateCallback) {
	r.callbacks["OnP2PCallInitiate"] = append(r.callbacks["OnP2PCallInitiate"], cb)
}
func (r *hubRegistrationRecorder) OnP2PCallAccept(cb ws.P2PCallAcceptCallback) {
	r.callbacks["OnP2PCallAccept"] = append(r.callbacks["OnP2PCallAccept"], cb)
}
func (r *hubRegistrationRecorder) OnP2PCallDecline(cb ws.P2PCallDeclineCallback) {
	r.callbacks["OnP2PCallDecline"] = append(r.callbacks["OnP2PCallDecline"], cb)
}
func (r *hubRegistrationRecorder) OnP2PCallEnd(cb ws.P2PCallEndCallback) {
	r.callbacks["OnP2PCallEnd"] = append(r.callbacks["OnP2PCallEnd"], cb)
}
func (r *hubRegistrationRecorder) OnP2PSignal(cb ws.P2PSignalCallback) {
	r.callbacks["OnP2PSignal"] = append(r.callbacks["OnP2PSignal"], cb)
}
func (r *hubRegistrationRecorder) OnChannelTyping(cb ws.ChannelTypingCallback) {
	r.callbacks["OnChannelTyping"] = append(r.callbacks["OnChannelTyping"], cb)
}
func (r *hubRegistrationRecorder) OnDMTyping(cb ws.DMTypingCallback) {
	r.callbacks["OnDMTyping"] = append(r.callbacks["OnDMTyping"], cb)
}
func (r *hubRegistrationRecorder) OnScreenShareWatch(cb ws.ScreenShareWatchCallback) {
	r.callbacks["OnScreenShareWatch"] = append(r.callbacks["OnScreenShareWatch"], cb)
}

func TestProductionHubCallbackCompositionRegistersEveryGroupExactlyOnce(t *testing.T) {
	base := []string{"OnUserFirstConnect", "OnUserFullyDisconnected", "OnPresenceManualUpdate", "OnVoiceJoin", "OnVoiceLeave", "OnVoiceStateUpdate", "OnVoiceAdminStateUpdate", "OnVoiceMoveUser", "OnVoiceDisconnectUser", "OnScreenShareWatch", "OnVoiceActivity", "OnP2PCallInitiate", "OnP2PCallAccept", "OnP2PCallDecline", "OnP2PCallEnd", "OnP2PSignal", "OnChannelTyping", "OnDMTyping"}
	optional := []string{"OnGameActivityConnect", "OnGameActivityUpdate", "OnGameActivityDisconnect", "OnGameActivitySnapshot", "OnGameActivityPresenceChange"}
	for _, enabled := range []bool{false, true} {
		name := "disabled game activity"
		if enabled {
			name = "enabled game activity"
		}
		t.Run(name, func(t *testing.T) {
			hub := &hubRegistrationRecorder{Hub: ws.NewHub(), callbacks: map[string][]any{}}
			t.Cleanup(hub.Shutdown)
			var game *services.GameActivityService
			if enabled {
				game = services.NewGameActivityService(nil, nil, nil, hub, hub.GameActivityEpoch())
				t.Cleanup(game.Stop)
			}
			voice, p2p := &voiceRoutingRecorder{}, &p2pRoutingRecorder{}
			stop := registerHubCallbacks(hub, nil, nil, voice, p2p, nil, nil, nil, game)
			t.Cleanup(stop)
			expected := append([]string{}, base...)
			if enabled {
				expected = append(expected, optional...)
			}
			if len(hub.callbacks) != len(expected) {
				t.Fatalf("registered groups=%d want=%d", len(hub.callbacks), len(expected))
			}
			for _, key := range expected {
				callbacks := hub.callbacks[key]
				if len(callbacks) != 1 || reflect.ValueOf(callbacks[0]).IsNil() {
					t.Fatalf("%s must have exactly one nonnil registration", key)
				}
			}
			hub.callbacks["OnVoiceActivity"][0].(ws.VoiceActivityCallback)("composed-active-user")
			hub.callbacks["OnP2PCallEnd"][0].(ws.P2PCallEndCallback)("composed-ender", "composed-call")
			if !reflect.DeepEqual(voice.calls, [][]any{{"activity", "composed-active-user"}}) || !reflect.DeepEqual(p2p.calls, [][]any{{"end", "composed-ender", "composed-call"}}) {
				t.Fatal("production composition did not connect supplied services")
			}
		})
	}
}
