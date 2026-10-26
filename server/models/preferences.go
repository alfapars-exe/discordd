package models

import (
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"strings"
	"unicode/utf8"
)

// UserPreferences holds all client-synced settings as a flexible JSON blob.
// Known write namespaces are validated; existing unrecognized stored keys are
// preserved for older clients. Preferences never grant permissions.
type UserPreferences struct {
	SchemaVersion int             `json:"schema_version"`
	UserID        string          `json:"user_id"`
	Data          json.RawMessage `json:"data"`
	UpdatedAt     string          `json:"updated_at"`
}

// UpdatePreferencesRequest is the PATCH request body.
// It accepts a partial JSON object that is merged with existing data.
type UpdatePreferencesRequest struct {
	// Optional for older clients. This is an account-affinity assertion, never
	// an authorization source or a destination selected by the caller.
	ExpectedUserID string `json:"expected_user_id,omitempty"`
	// Partial JSON object — keys present are merged, missing keys are untouched.
	Data json.RawMessage `json:"data"`
}

const PreferencesSchemaVersion = 1
const MaxPreferencesPatchBytes = 64 * 1024
const MaxPreferencesStoredBytes = 256 * 1024

// Validate checks the complete patch before json_patch can merge it. Null is
// deliberately not a deletion operation. gif_favorites is the only array field.
func (r *UpdatePreferencesRequest) Validate() error {
	if len(r.Data) == 0 || len(r.Data) > MaxPreferencesPatchBytes {
		return fmt.Errorf("data is required")
	}
	var obj map[string]any
	if err := json.Unmarshal(r.Data, &obj); err != nil || obj == nil {
		return fmt.Errorf("data must be a JSON object")
	}
	for key, value := range obj {
		validator, ok := preferenceNamespaces[key]
		if !ok || !validator(value) {
			return fmt.Errorf("invalid preference field")
		}
	}
	return nil
}

type preferenceValidator func(any) bool

func preferenceBool(v any) bool { _, ok := v.(bool); return ok }
func preferenceString(max int) preferenceValidator {
	return func(v any) bool { s, ok := v.(string); return ok && utf8.RuneCountInString(s) <= max }
}
func preferenceNumber(min, max float64) preferenceValidator {
	return func(v any) bool {
		n, ok := v.(float64)
		return ok && !math.IsNaN(n) && !math.IsInf(n, 0) && n >= min && n <= max
	}
}
func preferenceEnum(values ...string) preferenceValidator {
	return func(v any) bool {
		s, ok := v.(string)
		if !ok {
			return false
		}
		for _, allowed := range values {
			if s == allowed {
				return true
			}
		}
		return false
	}
}
func preferenceNumbers(values ...float64) preferenceValidator {
	return func(v any) bool {
		n, ok := v.(float64)
		if !ok {
			return false
		}
		for _, allowed := range values {
			if n == allowed {
				return true
			}
		}
		return false
	}
}
func preferenceObject(fields map[string]preferenceValidator) preferenceValidator {
	return func(v any) bool {
		obj, ok := v.(map[string]any)
		if !ok || obj == nil {
			return false
		}
		for key, value := range obj {
			valid, known := fields[key]
			if !known || !valid(value) {
				return false
			}
		}
		return true
	}
}
func preferenceMap(max int, valid preferenceValidator) preferenceValidator {
	return func(v any) bool {
		obj, ok := v.(map[string]any)
		if !ok || obj == nil || len(obj) > max {
			return false
		}
		for key, value := range obj {
			if key == "" || len(key) > 256 || key == "__proto__" || key == "constructor" || key == "prototype" || !valid(value) {
				return false
			}
		}
		return true
	}
}

var preferenceNamespaces = map[string]preferenceValidator{
	"theme":            preferenceString(128),
	"sidebar_sections": preferenceMap(256, preferenceBool),
	"sidebar_expanded": preferenceBool,
	"appearance": preferenceObject(map[string]preferenceValidator{
		"blurEnabled": preferenceBool, "blurStrength": preferenceNumber(8, 40),
		"wallpaperEnabled": preferenceBool, "lightningEnabled": preferenceBool,
		"lightningBlur": preferenceNumber(0, 20), "neonEnabled": preferenceBool,
		"neonIntensity": preferenceNumber(0, 100), "uiScale": preferenceNumber(50, 200),
		"avatarAnimation": preferenceEnum("hover", "always"),
	}),
	"cosmetics_view":  preferenceObject(map[string]preferenceValidator{"plain": preferenceBool}),
	"entrance_sounds": preferenceObject(map[string]preferenceValidator{"enabled": preferenceBool, "volume": preferenceNumber(0, 100)}),
	"accessibility": preferenceObject(map[string]preferenceValidator{
		"chatFontSize": preferenceNumber(12, 24), "alwaysUnderlineLinks": preferenceBool,
		"showDisplayNameStyles": preferenceBool, "density": preferenceEnum("compact", "default", "cozy"),
		"messageStyle": preferenceEnum("default", "compact"), "messageGroupGapPx": preferenceNumber(0, 24),
		"saturation": preferenceNumber(0, 100), "saturateCustomColors": preferenceBool,
		"highContrast": preferenceBool, "syncHighContrast": preferenceBool, "showSwitchIndicators": preferenceBool,
		"roleColorMode":        preferenceEnum("names", "dots", "hidden"),
		"officialMessageStyle": preferenceEnum("default", "subtle", "prominent"),
		"reduceMotion":         preferenceBool, "syncReducedMotion": preferenceBool, "disableAnimatedEmoji": preferenceBool, "autoplayGifs": preferenceBool,
		"stickerAnimation":        preferenceEnum("always", "interaction", "never"),
		"notificationSoundVolume": preferenceNumber(0, 100), "ttsEnabled": preferenceBool,
		"ttsRate": preferenceNumber(0.5, 2), "notificationDuration": preferenceNumbers(3, 5, 10, 15, 20),
		"showImageDescriptions": preferenceBool, "legacyComposer": preferenceBool,
	}),
	"notifications": preferenceObject(map[string]preferenceValidator{
		"desktopEnabled": preferenceBool, "taskbarFlash": preferenceBool,
		"unreadBadge": preferenceBool, "reactionMode": preferenceEnum("all", "direct", "none"),
		"soundPack":    preferenceEnum("classic", "soft", "minimal"),
		"messageSound": preferenceBool, "currentChannelSound": preferenceBool,
		"incomingCallSound": preferenceBool, "muteAllSounds": preferenceBool,
		"voiceStreamStartSound": preferenceBool, "voiceStreamStopSound": preferenceBool, "voiceJoinSound": preferenceBool, "voiceLeaveSound": preferenceBool, "voiceWatchStartSound": preferenceBool, "voiceWatchStopSound": preferenceBool, "voiceMuteSound": preferenceBool, "voiceUnmuteSound": preferenceBool, "voiceDeafenSound": preferenceBool, "voiceUndeafenSound": preferenceBool,
		"notifyWhenFocused": preferenceBool, "streamNotifications": preferenceBool,
		"desktopDelaySeconds":       preferenceNumbers(0, 3, 5, 10),
		"onlineFriendNotifications": preferenceBool, "friendAnniversaryNotifications": preferenceBool,
		"profileUpdateNotifications": preferenceBool,
		"upcomingEventNotifications": preferenceBool,
	}),
	"email_preferences": preferenceObject(map[string]preferenceValidator{
		"communication": preferenceBool, "social": preferenceBool,
		"announcements": preferenceBool, "tips": preferenceBool,
		"recommendations": preferenceBool, "marketingUnsubscribed": preferenceBool,
	}),
	"locale": preferenceObject(map[string]preferenceValidator{"timeFormat": preferenceEnum("auto", "12", "24")}),
	"privacy": preferenceObject(map[string]preferenceValidator{
		"improvementTelemetry": preferenceBool,
		"profileAudience":      preferenceEnum("all_servers", "small_servers", "friends_only"),
		// Game activity has its own audience contract; it is separate from
		// profile visibility and online notification preferences.
		"shareGameActivity":                preferenceBool,
		"allowFriendsToJoinGame":           preferenceBool,
		"allowVoiceParticipantsToJoinGame": preferenceBool,
		"gameActivityNewServerAudience":    preferenceEnum("all", "small", "none"),
		"gameActivityServerOverrides":      preferenceMap(1024, preferenceBool),
		"shareProfileUpdates":              preferenceBool,
		"shareOnlineUpdates":               preferenceBool,
		"shareStreamUpdates":               preferenceBool,
		"clipVoiceConsent":                 preferenceBool,
		"experiencePersonalization":        preferenceBool,
		"friendRequests": preferenceObject(map[string]preferenceValidator{
			"everyone": preferenceBool,
			"mutual":   preferenceBool,
			"server":   preferenceBool,
		}),
		"ignoredUsers":               preferenceMap(1024, preferenceBool),
		"personalizedFriendMessages": preferenceBool,
		"spamFilter":                 preferenceEnum("all", "nonfriends", "off"),
		"spamRestoredMessages":       preferenceMap(1024, preferenceString(64)),
		"serverDMDefault":            preferenceBool,
		"serverDMOverrides":          preferenceMap(1024, preferenceBool),
		"sensitiveMedia": preferenceObject(map[string]preferenceValidator{
			"friendDMs": preferenceEnum("show", "blur", "block"),
			"otherDMs":  preferenceEnum("show", "blur", "block"),
			"channels":  preferenceEnum("show", "blur", "block"),
		}),
		"disturbingMedia": preferenceObject(map[string]preferenceValidator{
			"friendDMs": preferenceEnum("show", "blur", "block"),
			"otherDMs":  preferenceEnum("show", "blur", "block"),
			"channels":  preferenceEnum("show", "blur", "block"),
		}),
	}),
	"voice_settings": preferenceObject(map[string]preferenceValidator{
		"inputMode": preferenceEnum("voice_activity", "push_to_talk"), "pttKey": preferenceString(64),
		"micSensitivity": preferenceNumber(0, 100), "userVolumes": preferenceMap(1024, preferenceNumber(0, 200)),
		"inputDevice": preferenceString(1024), "outputDevice": preferenceString(1024), "cameraDevice": preferenceString(1024),
		"masterVolume": preferenceNumber(0, 100), "inputVolume": preferenceNumber(0, 200),
		"soundsEnabled": preferenceBool, "localMutedUsers": preferenceMap(1024, preferenceBool),
		"noiseReduction": preferenceBool, "noiseReductionEngine": preferenceEnum("rnnoise", "krisp", "webrtc", "deepfilter", "gtcrn", "dtln", "speex", "dpdfnet"),
		"noiseSuppressionLevel": preferenceEnum("low", "medium", "high", "maximum"), "deepfilterSuppression": preferenceNumber(0, 100),
		"screenShareVolumes": preferenceMap(1024, preferenceNumber(0, 200)), "screenShareAudio": preferenceBool,
		"screenShareQuality": preferenceEnum("720p", "1080p", "1440p", "native"), "screenShareFps": preferenceNumbers(-1, 30, 60, 120),
		"screenShareShowCursor": preferenceBool, "screenShareLowLatency": preferenceBool, "screenShareMode": preferenceEnum("motion", "detail"),
		"cameraQuality": preferenceEnum("360p", "720p", "1080p"), "cameraFps": preferenceNumbers(15, 30),
		"micProfile": preferenceEnum("konusma", "muzik"), "muteHotkeyEnabled": preferenceBool,
		"muteHotkey": preferenceString(64), "muteHotkeyGlobal": preferenceBool,
	}),
	"gif_favorites": validPreferenceGIFs,
}

func validPreferenceGIFs(v any) bool {
	items, ok := v.([]any)
	if !ok || len(items) > 50 {
		return false
	}
	validURL := func(v any) bool {
		s, ok := v.(string)
		if !ok || len(s) > 2048 {
			return false
		}
		u, err := url.Parse(s)
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil {
			return false
		}
		return strings.ToLower(u.Host) == "static.klipy.com" && len(u.Path) > 1 && !strings.ContainsAny(s, " \t\n\r")
	}
	fields := map[string]preferenceValidator{
		"id":    func(v any) bool { s, ok := v.(string); return ok && s != "" && utf8.RuneCountInString(s) <= 128 },
		"title": preferenceString(200), "url": validURL, "preview_url": validURL,
		"width": preferenceNumber(0, 16384), "height": preferenceNumber(0, 16384),
	}
	for _, item := range items {
		if !preferenceObject(fields)(item) {
			return false
		}
		obj := item.(map[string]any)
		for key, validator := range fields {
			if !validator(obj[key]) {
				return false
			}
		}
	}
	return true
}

// FilterDeviceLocalPreferences removes legacy synced hardware identifiers on
// reads as well as writes, and replaces hidden paid/obsolete noise engines with
// the free default. All unrelated stored keys are preserved.
func FilterDeviceLocalPreferences(data json.RawMessage) (json.RawMessage, error) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(data, &obj); err != nil || obj == nil {
		return nil, fmt.Errorf("invalid stored preferences")
	}
	if raw, ok := obj["voice_settings"]; ok {
		var voice map[string]json.RawMessage
		if json.Unmarshal(raw, &voice) == nil && voice != nil {
			for _, key := range []string{"inputDevice", "outputDevice", "cameraDevice", "muteHotkeyGlobal"} {
				delete(voice, key)
			}
			var engine string
			if json.Unmarshal(voice["noiseReductionEngine"], &engine) == nil && (engine == "krisp" || engine == "dpdfnet") {
				voice["noiseReductionEngine"] = json.RawMessage(`"rnnoise"`)
			}
			obj["voice_settings"], _ = json.Marshal(voice)
		}
	}
	return json.Marshal(obj)
}
