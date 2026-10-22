// Package models — entrance.go: voice-channel entrance sounds (migration 088).
//
// A user picks, per scope (global or one server), either an uploaded clip
// (server-measured PCM WAV) or a parametric preset that the client
// synthesizes. The server plays nothing itself: on a fresh voice join it
// broadcasts EntranceSoundPlayEvent to that channel's participants.
package models

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/argeinfina/hichat/pkg"
)

const (
	// MaxEntranceSoundsPerUser caps uploaded clips per account; enforced
	// atomically by the repository insert.
	MaxEntranceSoundsPerUser = 5
	// EntranceMaxUploadBytes caps the uploaded clip (multipart part and the
	// bytes actually read).
	EntranceMaxUploadBytes = 1 << 20
	// EntranceMinDurationMs / EntranceMaxDurationMs bound a clip's measured
	// length.
	EntranceMinDurationMs = 100
	EntranceMaxDurationMs = 5000
	// EntranceNameMaxRunes caps a clip's display name.
	EntranceNameMaxRunes = 32
	// EntranceCooldown is the per-user replay window: a second join within
	// it (leave+rejoin, channel hop) plays nothing.
	EntranceCooldown = 30 * time.Second
	// EntranceServerMaxMsMin is the lowest max_duration_ms a server may set
	// (the highest is EntranceMaxDurationMs).
	EntranceServerMaxMsMin = 500
	// EntrancePresetMaxBytes caps a raw preset JSON document.
	EntrancePresetMaxBytes = 256

	// EntranceScopeGlobal is the API spelling of the global scope (stored
	// as scope_server_id = '').
	EntranceScopeGlobal = "global"

	EntranceKindClip   = "clip"
	EntranceKindPreset = "preset"
	EntranceKindNone   = "none"
)

// Entrance errors. Messages are fixed literals (CWE-209); each wraps the pkg
// sentinel that decides its HTTP status, and the handler attaches the
// matching ENTRANCE_* code.
var (
	ErrEntranceNameInvalid      = fmt.Errorf("%w: name must be 1-32 characters without control or formatting characters", pkg.ErrBadRequest)
	ErrEntranceFileTooLarge     = fmt.Errorf("%w: entrance sound file is too large (max 1 MiB)", pkg.ErrBadRequest)
	ErrEntranceInvalidAudio     = fmt.Errorf("%w: entrance sound must be a 16-bit PCM WAV file", pkg.ErrBadRequest)
	ErrEntranceDurationInvalid  = fmt.Errorf("%w: entrance sound must be between 100 and 5000 ms long", pkg.ErrBadRequest)
	ErrEntranceLimitReached     = fmt.Errorf("%w: you have reached the entrance sound limit", pkg.ErrBadRequest)
	ErrEntrancePresetInvalid    = fmt.Errorf("%w: invalid entrance preset", pkg.ErrBadRequest)
	ErrEntranceScopeInvalid     = fmt.Errorf("%w: invalid entrance selection", pkg.ErrBadRequest)
	ErrEntranceSettingsInvalid  = fmt.Errorf("%w: invalid entrance settings", pkg.ErrBadRequest)
	ErrEntranceChannelNotVoice  = fmt.Errorf("%w: channel is not a voice channel", pkg.ErrBadRequest)
	ErrEntranceHierarchy        = fmt.Errorf("%w: you cannot moderate this member's entrance sound", pkg.ErrForbidden)
	ErrEntranceSoundNotFound    = fmt.Errorf("%w: entrance sound not found", pkg.ErrNotFound)
	ErrEntranceMemberNotFound   = fmt.Errorf("%w: member not found", pkg.ErrNotFound)
	ErrEntranceChannelNotFound  = fmt.Errorf("%w: channel not found", pkg.ErrNotFound)
	ErrEntranceServerNotFound   = fmt.Errorf("%w: server not found", pkg.ErrNotFound)
	ErrEntranceSelfMute         = fmt.Errorf("%w: you cannot mute your own entrance sound", pkg.ErrBadRequest)
	errEntrancePresetTrailing   = errors.New("trailing data after preset")
	errEntrancePresetOutOfRange = errors.New("preset field out of range")
)

// EntranceSound is one uploaded clip. URL is server-generated
// ("/api/uploads/entrance/{16hex}.wav"), never client input.
type EntranceSound struct {
	ID         string `json:"id"`
	UserID     string `json:"-"`
	Name       string `json:"name"`
	URL        string `json:"url"`
	DurationMs int    `json:"duration_ms"`
	Size       int64  `json:"size"`
	CreatedAt  string `json:"created_at"` // RFC3339 UTC
}

// EntrancePreset is the strict parametric preset (schema v1). Field order
// here is the canonical serialization order.
type EntrancePreset struct {
	V          int    `json:"v"`
	Theme      string `json:"theme"`
	Waveform   string `json:"waveform"`
	Pitch      int    `json:"pitch"`
	DurationMs int    `json:"duration_ms"`
}

var entranceThemes = map[string]bool{
	"chime": true, "rise": true, "fall": true, "arcade": true, "bell": true, "fanfare": true,
}

var entranceWaveforms = map[string]bool{
	"sine": true, "triangle": true, "square": true, "sawtooth": true,
}

// entrancePresetWire decodes with pointer fields so a missing field is
// distinguishable from a zero value.
type entrancePresetWire struct {
	V          *int    `json:"v"`
	Theme      *string `json:"theme"`
	Waveform   *string `json:"waveform"`
	Pitch      *int    `json:"pitch"`
	DurationMs *int    `json:"duration_ms"`
}

// ValidateEntrancePreset strictly parses raw (≤256 bytes, one JSON object,
// no unknown or missing fields, integer pitch -12..12 and duration_ms
// 150..2000, known theme/waveform, v == 1) and returns the preset plus its
// canonical re-serialization. Every failure is ErrEntrancePresetInvalid.
func ValidateEntrancePreset(raw []byte) (EntrancePreset, []byte, error) {
	p, err := parseEntrancePreset(raw)
	if err != nil {
		// The decoder's own text is never surfaced (CWE-209).
		return EntrancePreset{}, nil, ErrEntrancePresetInvalid
	}
	canonical, err := json.Marshal(p)
	if err != nil {
		return EntrancePreset{}, nil, ErrEntrancePresetInvalid
	}
	return p, canonical, nil
}

func parseEntrancePreset(raw []byte) (EntrancePreset, error) {
	if len(raw) == 0 || len(raw) > EntrancePresetMaxBytes {
		return EntrancePreset{}, errEntrancePresetOutOfRange
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var w *entrancePresetWire
	if err := dec.Decode(&w); err != nil {
		return EntrancePreset{}, err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return EntrancePreset{}, errEntrancePresetTrailing
	}
	// JSON null decodes into a nil pointer; missing fields stay nil.
	if w == nil || w.V == nil || w.Theme == nil || w.Waveform == nil || w.Pitch == nil || w.DurationMs == nil {
		return EntrancePreset{}, errEntrancePresetOutOfRange
	}
	p := EntrancePreset{V: *w.V, Theme: *w.Theme, Waveform: *w.Waveform, Pitch: *w.Pitch, DurationMs: *w.DurationMs}
	if p.V != 1 || !entranceThemes[p.Theme] || !entranceWaveforms[p.Waveform] ||
		p.Pitch < -12 || p.Pitch > 12 || p.DurationMs < 150 || p.DurationMs > 2000 {
		return EntrancePreset{}, errEntrancePresetOutOfRange
	}
	return p, nil
}

// EntranceSelection is one scope's choice as the API returns it. Scope is
// "global" or a server id.
type EntranceSelection struct {
	Scope     string          `json:"scope"`
	Kind      string          `json:"kind"`
	SoundID   *string         `json:"sound_id"`
	Preset    *EntrancePreset `json:"preset"`
	UpdatedAt string          `json:"updated_at"` // RFC3339 UTC
}

// EntranceSelectionRow is the storage shape of a selection (scope_server_id
// '' = global, preset as canonical JSON text).
type EntranceSelectionRow struct {
	UserID        string
	ScopeServerID string
	Kind          string
	SoundID       *string
	Preset        *string
	UpdatedAt     string // RFC3339 UTC once read back
}

// ResolvedEntrance is what the play path needs: the winning selection for a
// (user, server) plus, for a clip, its file URL and measured duration.
type ResolvedEntrance struct {
	Kind       string
	SoundID    string
	SoundURL   string
	DurationMs int
	Preset     string // canonical preset JSON for kind preset
}

// EntranceMineResponse is GET /api/users/me/entrance-sounds.
type EntranceMineResponse struct {
	Sounds     []EntranceSound     `json:"sounds"`
	Selections []EntranceSelection `json:"selections"`
}

// PutEntranceSelectionRequest is PUT /api/users/me/entrance-selection.
type PutEntranceSelectionRequest struct {
	Scope   string          `json:"scope"`
	Kind    string          `json:"kind"`
	SoundID *string         `json:"sound_id,omitempty"`
	Preset  json.RawMessage `json:"preset,omitempty"`
}

// entranceScopeMaxLen bounds a scope string (server ids are 36-char UUIDs).
const entranceScopeMaxLen = 64

// Validate checks the request's shape: a non-empty bounded scope, a known
// kind, and exactly the field that kind needs. The preset document itself
// is validated by ValidateEntrancePreset in the service.
func (r *PutEntranceSelectionRequest) Validate() error {
	scope := strings.TrimSpace(r.Scope)
	if scope == "" || len(scope) > entranceScopeMaxLen || pkg.ContainsSteeringChars(scope) {
		return ErrEntranceScopeInvalid
	}
	r.Scope = scope
	switch r.Kind {
	case EntranceKindClip:
		if r.SoundID == nil || *r.SoundID == "" || len(*r.SoundID) > entranceScopeMaxLen {
			return ErrEntranceScopeInvalid
		}
	case EntranceKindPreset:
		if len(r.Preset) == 0 {
			return ErrEntrancePresetInvalid
		}
	case EntranceKindNone:
	default:
		return ErrEntranceScopeInvalid
	}
	return nil
}

// ServerEntranceSettings is a server's entrance-sound configuration.
type ServerEntranceSettings struct {
	ServerID           string   `json:"server_id"`
	Enabled            bool     `json:"enabled"`
	MaxDurationMs      int      `json:"max_duration_ms"`
	DisabledChannelIDs []string `json:"disabled_channel_ids"`
}

// PatchServerEntranceSettingsRequest is PATCH .../entrance-settings.
type PatchServerEntranceSettingsRequest struct {
	Enabled       *bool `json:"enabled,omitempty"`
	MaxDurationMs *int  `json:"max_duration_ms,omitempty"`
}

// Validate requires at least one field and max_duration_ms in 500..5000.
func (r *PatchServerEntranceSettingsRequest) Validate() error {
	if r.Enabled == nil && r.MaxDurationMs == nil {
		return ErrEntranceSettingsInvalid
	}
	if r.MaxDurationMs != nil && (*r.MaxDurationMs < EntranceServerMaxMsMin || *r.MaxDurationMs > EntranceMaxDurationMs) {
		return ErrEntranceSettingsInvalid
	}
	return nil
}

// SetChannelEntranceRequest is PUT .../channels/{channelId}/entrance.
type SetChannelEntranceRequest struct {
	Enabled *bool `json:"enabled"`
}

// EntranceMutesResponse is GET .../entrance-mutes.
type EntranceMutesResponse struct {
	UserIDs []string `json:"user_ids"`
}

// EntranceSoundPlayEvent is the WS entrance_sound_play payload, sent only to
// the voice channel's participants (joiner included).
type EntranceSoundPlayEvent struct {
	ServerID  string          `json:"server_id"`
	ChannelID string          `json:"channel_id"`
	UserID    string          `json:"user_id"`
	Kind      string          `json:"kind"`
	SoundURL  string          `json:"sound_url,omitempty"`
	Preset    *EntrancePreset `json:"preset,omitempty"`
	PlayMs    int             `json:"play_ms"`
}

// ValidEntranceName reports whether name (already trimmed) is 1-32 runes
// without control or formatting characters.
func ValidEntranceName(name string) bool {
	n := utf8.RuneCountInString(name)
	return n >= 1 && n <= EntranceNameMaxRunes && utf8.ValidString(name) && !pkg.ContainsSteeringChars(name)
}
