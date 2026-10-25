package models

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
)

func TestPreferencesValidateKnownNamespaces(t *testing.T) {
	valid := []string{
		`{"notifications":{"upcomingEventNotifications":false}}`,
		`{"privacy":{"shareOnlineUpdates":false}}`,
		`{"privacy":{"shareStreamUpdates":true}}`,
		`{"privacy":{"shareGameActivity":true,"gameActivityNewServerAudience":"small","gameActivityServerOverrides":{"server-1":true,"server-2":false}}}`,
		`{}`,
		`{"voice_settings":{"noiseReductionEngine":"gtcrn"}}`,
		`{"theme":"ocean","sidebar_expanded":false,"sidebar_sections":{"server-1":true}}`,
		`{"appearance":{"blurEnabled":true,"blurStrength":40,"wallpaperEnabled":false,"lightningEnabled":true,"lightningBlur":20,"neonEnabled":true,"neonIntensity":100,"uiScale":50,"avatarAnimation":"hover"}}`,
		`{"cosmetics_view":{"plain":false},"entrance_sounds":{"enabled":true,"volume":100}}`,
		`{"accessibility":{"chatFontSize":24,"alwaysUnderlineLinks":true,"showDisplayNameStyles":false,"density":"cozy","messageStyle":"compact","messageGroupGapPx":0,"saturation":50.5,"saturateCustomColors":false,"reduceMotion":true,"disableAnimatedEmoji":true,"autoplayGifs":false,"notificationSoundVolume":0,"ttsEnabled":true}}`,
		`{"notifications":{"desktopEnabled":true,"taskbarFlash":false,"unreadBadge":true,"reactionMode":"direct","soundPack":"soft","messageSound":true,"currentChannelSound":false,"incomingCallSound":true,"muteAllSounds":false,"notifyWhenFocused":false,"desktopDelaySeconds":5,"streamNotifications":true,"onlineFriendNotifications":false,"friendAnniversaryNotifications":true,"profileUpdateNotifications":true}}`,
		`{"email_preferences":{"communication":true,"social":false,"announcements":true,"tips":false,"recommendations":true,"marketingUnsubscribed":false}}`,
		`{"privacy":{"personalizedFriendMessages":true,"spamFilter":"nonfriends","serverDMDefault":false,"serverDMOverrides":{"server-1":true},"sensitiveMedia":{"friendDMs":"show","otherDMs":"blur","channels":"block"},"disturbingMedia":{"friendDMs":"blur","otherDMs":"block","channels":"show"}}}`,
		`{"voice_settings":{"inputMode":"push_to_talk","pttKey":"Space","micSensitivity":100,"userVolumes":{"user-1":200},"masterVolume":0,"inputVolume":200,"soundsEnabled":true,"localMutedUsers":{"user-1":false},"noiseReduction":true,"noiseReductionEngine":"dpdfnet","noiseSuppressionLevel":"maximum","deepfilterSuppression":0,"screenShareVolumes":{"user-2":150},"screenShareAudio":true,"screenShareQuality":"native","screenShareFps":-1,"screenShareShowCursor":true,"screenShareLowLatency":false,"screenShareMode":"detail","cameraQuality":"360p","cameraFps":15,"micProfile":"muzik","muteHotkeyEnabled":true,"muteHotkey":"Control+M"}}`,
		// Legacy clients may send local device settings. Accepted but stripped at
		// the persistence boundary so upgrading does not break their other fields.
		`{"voice_settings":{"inputDevice":"opaque-mic-id","outputDevice":"default","cameraDevice":"opaque-camera-id","muteHotkeyGlobal":true}}`,
		`{"gif_favorites":[]}`,
		`{"gif_favorites":[{"id":"gif-1","title":"Favorite","url":"https://static.klipy.com/a.gif","preview_url":"http://static.klipy.com/a.jpg","width":0,"height":240}]}`,
		`{"gif_favorites":[{"id":"gif-2","title":"` + strings.Repeat("ş", 200) + `","url":"https://static.klipy.com/a.gif","preview_url":"https://static.klipy.com/a.jpg","width":100,"height":100}]}`,
	}
	for _, data := range valid {
		if err := (&UpdatePreferencesRequest{Data: json.RawMessage(data)}).Validate(); err != nil {
			t.Errorf("valid preferences rejected: %s: %v", data, err)
		}
	}
}

func TestPreferencesValidateRejectsMalformedAndOutOfRange(t *testing.T) {
	invalid := []string{
		`{"notifications":{"upcomingEventNotifications":"false"}}`,
		``, `null`, `[]`, `true`, `"theme"`, `{"theme":`,
		`{"unknown_namespace":true}`, `{"schema_version":1}`, `{"theme":null}`,
		`{"theme":{}}`, `{"sidebar_expanded":"true"}`, `{"sidebar_sections":[]}`,
		`{"sidebar_sections":{"a":null}}`, `{"sidebar_sections":{"__proto__":true}}`,
		`{"voice_settings":null}`, `{"voice_settings":[]}`, `{"voice_settings":{"unknown":true}}`,
		`{"voice_settings":{"masterVolume":101}}`, `{"voice_settings":{"inputVolume":-1}}`,
		`{"voice_settings":{"userVolumes":{"u":201}}}`, `{"voice_settings":{"screenShareVolumes":{"u":"100"}}}`,
		`{"voice_settings":{"localMutedUsers":{"u":null}}}`, `{"voice_settings":{"inputDevice":23}}`,
		`{"voice_settings":{"screenShareFps":45}}`, `{"voice_settings":{"cameraFps":60}}`,
		`{"voice_settings":{"screenShareQuality":"4k"}}`, `{"voice_settings":{"inputMode":"always"}}`,
		`{"voice_settings":{"noiseReductionEngine":"unknown"}}`, `{"voice_settings":{"micProfile":"speech"}}`,
		`{"accessibility":{"chatFontSize":11}}`, `{"accessibility":{"messageGroupGapPx":25}}`,
		`{"accessibility":{"saturation":101}}`, `{"accessibility":{"density":"wide"}}`,
		`{"appearance":{"blurStrength":7}}`, `{"appearance":{"lightningBlur":21}}`,
		`{"appearance":{"neonIntensity":101}}`, `{"appearance":{"uiScale":201}}`,
		`{"appearance":{"avatarAnimation":"never"}}`, `{"appearance":{"transparency":true}}`,
		`{"entrance_sounds":{"volume":-1}}`, `{"cosmetics_view":{"plain":1}}`,
		`{"notifications":{"reactionMode":"mentions"}}`, `{"notifications":{"soundPack":"loud"}}`, `{"notifications":{"desktopDelaySeconds":2}}`, `{"notifications":{"desktopDelaySeconds":15}}`, `{"notifications":{"desktopDelaySeconds":"5"}}`,
		`{"notifications":{"desktopEnabled":"true"}}`, `{"notifications":{"unknown":true}}`,
		`{"email_preferences":{"communication":"yes"}}`, `{"email_preferences":{"security":false}}`,
		`{"privacy":{"spamFilter":"friends"}}`, `{"privacy":{"serverDMDefault":"yes"}}`,
		`{"privacy":{"shareOnlineUpdates":"false"}}`,
		`{"privacy":{"shareStreamUpdates":"false"}}`,
		`{"privacy":{"shareGameActivity":"true"}}`,
		`{"privacy":{"gameActivityNewServerAudience":"friends"}}`,
		`{"privacy":{"gameActivityServerOverrides":{"server-1":"yes"}}}`,
		`{"privacy":{"serverDMOverrides":{"server-1":"yes"}}}`, `{"privacy":{"sensitiveMedia":{"channels":"hide"}}}`,
		`{"gif_favorites":null}`, `{"gif_favorites":{}}`, `{"gif_favorites":[null]}`,
		`{"gif_favorites":[{"id":"gif-1","title":"Favorite","url":"https://evil.example/a.gif","preview_url":"https://static.klipy.com/a.jpg","width":100,"height":100}]}`,
		`{"gif_favorites":[{"id":"gif-1","title":"Favorite","url":"https://static.klipy.com.evil.example/a.gif","preview_url":"https://static.klipy.com/a.jpg","width":100,"height":100}]}`,
		`{"gif_favorites":[{"id":"gif-1","url":"https://static.klipy.com/a.gif"}]}`,
		`{"theme":"` + strings.Repeat("x", 129) + `"}`,
		`{"theme":"` + strings.Repeat("x", MaxPreferencesPatchBytes) + `"}`,
	}
	for _, data := range invalid {
		if err := (&UpdatePreferencesRequest{Data: json.RawMessage(data)}).Validate(); err == nil {
			t.Errorf("invalid preferences accepted: %.200s", data)
		}
	}
}

func TestPreferencesValidateCollectionLimits(t *testing.T) {
	sections := map[string]bool{}
	for i := 0; i < 257; i++ {
		sections[strings.Repeat("s", i+1)] = true
	}
	data, _ := json.Marshal(map[string]any{"sidebar_sections": sections})
	if err := (&UpdatePreferencesRequest{Data: data}).Validate(); err == nil {
		t.Fatal("oversized map accepted")
	}
	gameOverrides := map[string]bool{}
	for i := 0; i < 1024; i++ {
		gameOverrides["g"+strconv.Itoa(i)] = true
	}
	data, _ = json.Marshal(map[string]any{"privacy": map[string]any{"gameActivityServerOverrides": gameOverrides}})
	if err := (&UpdatePreferencesRequest{Data: data}).Validate(); err != nil {
		t.Fatalf("1024 game activity server overrides rejected: %v", err)
	}
	gameOverrides["extra"] = true
	data, _ = json.Marshal(map[string]any{"privacy": map[string]any{"gameActivityServerOverrides": gameOverrides}})
	if err := (&UpdatePreferencesRequest{Data: data}).Validate(); err == nil {
		t.Fatal("1025 game activity server overrides accepted")
	}
	gif := map[string]any{"id": "x", "title": "", "url": "https://static.klipy.com/a.gif", "preview_url": "https://static.klipy.com/a.jpg", "width": 0, "height": 0}
	items := make([]any, 51)
	for i := range items {
		items[i] = gif
	}
	data, _ = json.Marshal(map[string]any{"gif_favorites": items})
	if err := (&UpdatePreferencesRequest{Data: data}).Validate(); err == nil {
		t.Fatal("51 favorites accepted")
	}
}

func TestPreferencesFilterDeviceLocalPreservesLegacyData(t *testing.T) {
	data, err := FilterDeviceLocalPreferences(json.RawMessage(`{"legacy":{"unknown":true},"voice_settings":{"inputDevice":"secret","outputDevice":"secret","cameraDevice":"secret","muteHotkeyGlobal":true,"masterVolume":60,"legacyFlag":true}}`))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "secret") || strings.Contains(string(data), "muteHotkeyGlobal") {
		t.Fatalf("local settings leaked: %s", data)
	}
	var decoded map[string]any
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["legacy"] == nil || decoded["voice_settings"].(map[string]any)["legacyFlag"] != true {
		t.Fatalf("legacy data lost: %s", data)
	}
	for _, bad := range []string{`null`, `[]`, `{`} {
		if _, err := FilterDeviceLocalPreferences(json.RawMessage(bad)); err == nil {
			t.Errorf("invalid stored root accepted: %s", bad)
		}
	}
}

func TestPreferencesNormalizeHiddenNoiseEngines(t *testing.T) {
	for _, engine := range []string{"krisp", "dpdfnet", "gtcrn", "deepfilter", "rnnoise", "dtln", "webrtc", "speex"} {
		t.Run(engine, func(t *testing.T) {
			input := json.RawMessage(`{"legacy":true,"voice_settings":{"noiseReductionEngine":"` + engine + `","masterVolume":65,"inputVolume":120}}`)
			data, err := FilterDeviceLocalPreferences(input)
			if err != nil {
				t.Fatal(err)
			}
			want := engine
			if engine == "krisp" || engine == "dpdfnet" {
				want = "rnnoise"
			}
			var decoded map[string]any
			if err := json.Unmarshal(data, &decoded); err != nil {
				t.Fatal(err)
			}
			voice := decoded["voice_settings"].(map[string]any)
			if voice["noiseReductionEngine"] != want || voice["masterVolume"] != float64(65) || voice["inputVolume"] != float64(120) || decoded["legacy"] != true {
				t.Fatalf("unexpected normalization: %s", data)
			}
		})
	}
}

func TestVoiceEventNotificationPreferences(t *testing.T) {
	for _, key := range []string{"voiceJoinSound", "voiceLeaveSound", "voiceWatchStartSound", "voiceWatchStopSound", "voiceMuteSound", "voiceUnmuteSound", "voiceDeafenSound", "voiceUndeafenSound"} {
		for _, value := range []string{"true", "false"} {
			if err := (&UpdatePreferencesRequest{Data: json.RawMessage(`{"notifications":{"` + key + `":` + value + `}}`)}).Validate(); err != nil {
				t.Errorf("boolean %s rejected: %v", key, err)
			}
		}
		for _, value := range []string{`"true"`, `1`, `null`} {
			if err := (&UpdatePreferencesRequest{Data: json.RawMessage(`{"notifications":{"` + key + `":` + value + `}}`)}).Validate(); err == nil {
				t.Errorf("invalid %s=%s accepted", key, value)
			}
		}
	}
}
