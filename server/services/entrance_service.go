// Package services — entrance_service.go: voice-channel entrance sounds.
//
// Clips are uploaded per account (max 5), measured and rewritten server-side
// (entrance_wav.go). A user's selection per scope (global or one server) is
// either a clip or a strict parametric preset. Playback is server-
// authoritative: VoiceService.JoinChannel calls OnVoiceJoined on a fresh,
// authorized join, which broadcasts entrance_sound_play to that channel's
// participants only. Clients have no "play" request.
package services

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

var entranceLogger = logx.Component("service.entrance")

const (
	entranceSubdir = "entrance"
	// entranceCooldownPruneAt is the cooldown-map size at which entries
	// older than the cooldown are dropped.
	entranceCooldownPruneAt = 1024
)

// entranceSoundURLPattern is the exact URL shape CreateSound generates. File
// removal and the play path only ever trust URLs matching it (§4 #247).
var entranceSoundURLPattern = regexp.MustCompile(`^/api/uploads/entrance/[a-f0-9]{16}\.wav$`)

// EntranceMemberChecker reports server membership (repository.ServerRepository).
type EntranceMemberChecker interface {
	IsMember(ctx context.Context, serverID, userID string) (bool, error)
}

// EntranceRoleGetter lists a member's roles for the hierarchy check
// (repository.RoleRepository).
type EntranceRoleGetter interface {
	GetByUserIDAndServer(ctx context.Context, userID, serverID string) ([]models.Role, error)
}

// EntranceService manages entrance sounds, selections and their server-side
// controls, and fires the play broadcast on voice joins.
type EntranceService interface {
	ListMine(ctx context.Context, userID string) (*models.EntranceMineResponse, error)
	// CreateSound stores an uploaded clip. Only file and name are inputs —
	// duration, size and URL are always server-derived.
	CreateSound(ctx context.Context, userID, name string, file multipart.File, header *multipart.FileHeader) (*models.EntranceSound, error)
	RenameSound(ctx context.Context, userID, id, name string) (*models.EntranceSound, error)
	// DeleteSound removes the clip and the selections using it, then its file.
	DeleteSound(ctx context.Context, userID, id string) error
	// PutSelection sets (or with kind "none" clears) one scope's selection
	// and returns all of the user's selections.
	PutSelection(ctx context.Context, userID string, req *models.PutEntranceSelectionRequest) ([]models.EntranceSelection, error)

	GetServerSettings(ctx context.Context, serverID string) (*models.ServerEntranceSettings, error)
	PatchServerSettings(ctx context.Context, serverID string, req *models.PatchServerEntranceSettingsRequest) (*models.ServerEntranceSettings, error)
	// SetChannelEnabled switches entrance sounds on/off for one voice
	// channel of serverID.
	SetChannelEnabled(ctx context.Context, serverID, channelID string, enabled bool) error
	ListMutes(ctx context.Context, serverID string) ([]string, error)
	// SetMute mutes/unmutes targetID's entrance sound on serverID, subject
	// to the role hierarchy (owner never, actor must outrank target).
	SetMute(ctx context.Context, serverID, actorID, targetID string, muted bool) error

	// OnVoiceJoined implements VoiceEntranceHook.
	OnVoiceJoined(userID, serverID, channelID string)
}

type entranceService struct {
	repo         repository.EntranceRepository
	members      EntranceMemberChecker
	roles        EntranceRoleGetter
	channels     ChannelGetter
	permResolver ChannelPermResolver
	hub          ws.Broadcaster
	voice        VoiceStateGetter
	uploadDir    string

	nowFn      func() time.Time
	mu         sync.Mutex
	lastPlayed map[string]time.Time // userID -> last broadcast
}

func NewEntranceService(
	repo repository.EntranceRepository,
	members EntranceMemberChecker,
	roles EntranceRoleGetter,
	channels ChannelGetter,
	permResolver ChannelPermResolver,
	hub ws.Broadcaster,
	voice VoiceStateGetter,
	uploadDir string,
) EntranceService {
	if uploadDir != "" {
		dir := filepath.Join(uploadDir, entranceSubdir)
		if err := os.MkdirAll(dir, 0o750); err != nil {
			entranceLogger.Warn("failed to create entrance dir", "dir", dir, "err", pkg.ErrText(err))
		}
	}
	return &entranceService{
		repo:         repo,
		members:      members,
		roles:        roles,
		channels:     channels,
		permResolver: permResolver,
		hub:          hub,
		voice:        voice,
		uploadDir:    uploadDir,
		nowFn:        time.Now,
		lastPlayed:   make(map[string]time.Time),
	}
}

// ─── Library ───

func (s *entranceService) ListMine(ctx context.Context, userID string) (*models.EntranceMineResponse, error) {
	sounds, err := s.repo.ListSounds(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list entrance sounds: %w", err)
	}
	selections, err := s.selections(ctx, userID)
	if err != nil {
		return nil, err
	}
	return &models.EntranceMineResponse{Sounds: sounds, Selections: selections}, nil
}

func (s *entranceService) CreateSound(ctx context.Context, userID, name string, file multipart.File, header *multipart.FileHeader) (*models.EntranceSound, error) {
	name = strings.TrimSpace(name)
	if !models.ValidEntranceName(name) {
		return nil, models.ErrEntranceNameInvalid
	}
	if header.Size > models.EntranceMaxUploadBytes {
		return nil, models.ErrEntranceFileTooLarge
	}
	// Claim + sniff gate shared with the soundboard. The replay reader (not
	// file) carries the sniffed first 512 bytes (§4 #163).
	replay, err := validateSoundUpload(file, header)
	if err != nil {
		return nil, models.ErrEntranceInvalidAudio
	}
	raw, err := io.ReadAll(io.LimitReader(replay, models.EntranceMaxUploadBytes+1))
	if err != nil {
		return nil, models.ErrEntranceInvalidAudio
	}
	if len(raw) > models.EntranceMaxUploadBytes {
		return nil, models.ErrEntranceFileTooLarge
	}
	pcm, channels, rate, durationMs, err := ParsePCMWav(raw)
	if err != nil {
		return nil, err
	}
	canonical := EncodeCanonicalWav(pcm, channels, rate)

	idBytes := make([]byte, 8)
	if _, err := rand.Read(idBytes); err != nil {
		return nil, fmt.Errorf("generate entrance sound id: %w", err)
	}
	id := hex.EncodeToString(idBytes)
	dir := filepath.Join(s.uploadDir, entranceSubdir)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, fmt.Errorf("create entrance dir: %w", err)
	}
	destPath, err := pkg.SafeJoin(dir, id+".wav")
	if err != nil {
		return nil, fmt.Errorf("%w: invalid upload destination", pkg.ErrBadRequest)
	}
	if err := writeUploadFile(destPath, bytes.NewReader(canonical), "create file", "save file", "finalize file"); err != nil {
		return nil, err
	}

	sound := &models.EntranceSound{
		ID:         id,
		UserID:     userID,
		Name:       name,
		URL:        "/api/uploads/" + entranceSubdir + "/" + id + ".wav",
		DurationMs: durationMs,
		Size:       int64(len(canonical)),
	}
	if err := s.repo.CreateSoundWithCap(ctx, sound, models.MaxEntranceSoundsPerUser); err != nil {
		_ = os.Remove(destPath)
		if errors.Is(err, models.ErrEntranceLimitReached) {
			return nil, err
		}
		return nil, fmt.Errorf("create entrance sound record: %w", err)
	}
	return sound, nil
}

func (s *entranceService) RenameSound(ctx context.Context, userID, id, name string) (*models.EntranceSound, error) {
	name = strings.TrimSpace(name)
	if !models.ValidEntranceName(name) {
		return nil, models.ErrEntranceNameInvalid
	}
	if err := s.repo.RenameSound(ctx, userID, id, name); err != nil {
		return nil, err
	}
	return s.repo.GetSound(ctx, userID, id)
}

func (s *entranceService) DeleteSound(ctx context.Context, userID, id string) error {
	fileURL, err := s.repo.DeleteSound(ctx, userID, id)
	if err != nil {
		return err
	}
	// File after the row (and its selections) are committed: a failed
	// removal leaves an unserved file, never a row pointing at nothing.
	if entranceSoundURLPattern.MatchString(fileURL) {
		removeUploadFilesByURL(s.uploadDir, []string{fileURL})
	}
	return nil
}

// ─── Selection ───

func (s *entranceService) PutSelection(ctx context.Context, userID string, req *models.PutEntranceSelectionRequest) ([]models.EntranceSelection, error) {
	if err := req.Validate(); err != nil {
		return nil, err
	}
	scopeServerID := ""
	if req.Scope != models.EntranceScopeGlobal {
		ok, err := s.members.IsMember(ctx, req.Scope, userID)
		if err != nil {
			return nil, fmt.Errorf("check membership: %w", err)
		}
		if !ok {
			return nil, models.ErrEntranceServerNotFound
		}
		scopeServerID = req.Scope
	}

	switch req.Kind {
	case models.EntranceKindNone:
		if err := s.repo.DeleteSelection(ctx, userID, scopeServerID); err != nil {
			return nil, err
		}
	case models.EntranceKindClip:
		if _, err := s.repo.GetSound(ctx, userID, *req.SoundID); err != nil {
			return nil, err
		}
		soundID := *req.SoundID
		if err := s.repo.UpsertSelection(ctx, &models.EntranceSelectionRow{
			UserID: userID, ScopeServerID: scopeServerID, Kind: models.EntranceKindClip, SoundID: &soundID,
		}); err != nil {
			return nil, err
		}
	case models.EntranceKindPreset:
		_, canonical, err := models.ValidateEntrancePreset(req.Preset)
		if err != nil {
			return nil, err
		}
		preset := string(canonical)
		if err := s.repo.UpsertSelection(ctx, &models.EntranceSelectionRow{
			UserID: userID, ScopeServerID: scopeServerID, Kind: models.EntranceKindPreset, Preset: &preset,
		}); err != nil {
			return nil, err
		}
	}
	return s.selections(ctx, userID)
}

// selections converts the stored rows to the API shape ("global" scope,
// parsed preset).
func (s *entranceService) selections(ctx context.Context, userID string) ([]models.EntranceSelection, error) {
	rows, err := s.repo.ListSelections(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list entrance selections: %w", err)
	}
	out := make([]models.EntranceSelection, 0, len(rows))
	for _, r := range rows {
		sel := models.EntranceSelection{
			Scope:     r.ScopeServerID,
			Kind:      r.Kind,
			SoundID:   r.SoundID,
			UpdatedAt: r.UpdatedAt,
		}
		if sel.Scope == "" {
			sel.Scope = models.EntranceScopeGlobal
		}
		if r.Preset != nil {
			var p models.EntrancePreset
			if err := json.Unmarshal([]byte(*r.Preset), &p); err == nil {
				sel.Preset = &p
			}
		}
		out = append(out, sel)
	}
	return out, nil
}

// ─── Server controls ───

func (s *entranceService) GetServerSettings(ctx context.Context, serverID string) (*models.ServerEntranceSettings, error) {
	settings, err := s.repo.GetServerSettings(ctx, serverID)
	if err != nil {
		return nil, err
	}
	disabled, err := s.repo.ListDisabledChannels(ctx, serverID)
	if err != nil {
		return nil, err
	}
	settings.DisabledChannelIDs = disabled
	return settings, nil
}

func (s *entranceService) PatchServerSettings(ctx context.Context, serverID string, req *models.PatchServerEntranceSettingsRequest) (*models.ServerEntranceSettings, error) {
	if err := req.Validate(); err != nil {
		return nil, err
	}
	if err := s.repo.PatchServerSettings(ctx, serverID, req.Enabled, req.MaxDurationMs); err != nil {
		return nil, err
	}
	return s.GetServerSettings(ctx, serverID)
}

func (s *entranceService) SetChannelEnabled(ctx context.Context, serverID, channelID string, enabled bool) error {
	ch, err := s.channels.GetByID(ctx, channelID)
	if err != nil {
		if errors.Is(err, pkg.ErrNotFound) {
			return models.ErrEntranceChannelNotFound
		}
		return fmt.Errorf("get channel: %w", err)
	}
	// Another server's channel is indistinguishable from a missing one.
	if ch == nil || ch.ServerID != serverID {
		return models.ErrEntranceChannelNotFound
	}
	if ch.Type != models.ChannelTypeVoice {
		return models.ErrEntranceChannelNotVoice
	}
	return s.repo.SetChannelDisabled(ctx, serverID, channelID, !enabled)
}

func (s *entranceService) ListMutes(ctx context.Context, serverID string) ([]string, error) {
	return s.repo.ListMutes(ctx, serverID)
}

func (s *entranceService) SetMute(ctx context.Context, serverID, actorID, targetID string, muted bool) error {
	if actorID == targetID {
		return models.ErrEntranceSelfMute
	}
	if muted {
		ok, err := s.members.IsMember(ctx, serverID, targetID)
		if err != nil {
			return fmt.Errorf("check membership: %w", err)
		}
		if !ok {
			return models.ErrEntranceMemberNotFound
		}
	}
	// Same semantics as memberService.checkHierarchy: the owner can never be
	// targeted and the actor's highest role must outrank the target's.
	targetRoles, err := s.roles.GetByUserIDAndServer(ctx, targetID, serverID)
	if err != nil {
		return fmt.Errorf("get target roles: %w", err)
	}
	if models.HasOwnerRole(targetRoles) {
		return models.ErrEntranceHierarchy
	}
	actorRoles, err := s.roles.GetByUserIDAndServer(ctx, actorID, serverID)
	if err != nil {
		return fmt.Errorf("get actor roles: %w", err)
	}
	if models.HighestPosition(actorRoles) <= models.HighestPosition(targetRoles) {
		return models.ErrEntranceHierarchy
	}
	return s.repo.SetMute(ctx, serverID, targetID, muted)
}

// ─── Play (VoiceEntranceHook) ───

// OnVoiceJoined runs the play gates cheapest first — cooldown, server
// switch, channel switch, moderator mute, PermUseEntranceSound, selection,
// still-in-channel — and broadcasts entrance_sound_play to the channel's
// participants (joiner included). Every failure is silent (debug log): a
// missing entrance sound is never an error the joiner sees.
func (s *entranceService) OnVoiceJoined(userID, serverID, channelID string) {
	if s.recentlyPlayed(userID) {
		return
	}
	ctx, cancel := BroadcastContext()
	defer cancel()

	settings, err := s.repo.GetServerSettings(ctx, serverID)
	if err != nil || !settings.Enabled {
		s.skip("server disabled or unreadable", userID, err)
		return
	}
	if off, err := s.repo.IsChannelDisabled(ctx, channelID); err != nil || off {
		s.skip("channel disabled or unreadable", userID, err)
		return
	}
	if muted, err := s.repo.IsMuted(ctx, serverID, userID); err != nil || muted {
		s.skip("muted or unreadable", userID, err)
		return
	}
	perms, err := s.permResolver.ResolveChannelPermissions(ctx, userID, channelID)
	if err != nil || !perms.Has(models.PermUseEntranceSound) {
		s.skip("no permission", userID, err)
		return
	}
	sel, err := s.repo.ResolveSelection(ctx, userID, serverID)
	if err != nil || sel == nil {
		s.skip("no selection", userID, err)
		return
	}

	event := models.EntranceSoundPlayEvent{ServerID: serverID, ChannelID: channelID, UserID: userID, Kind: sel.Kind}
	duration := 0
	switch sel.Kind {
	case models.EntranceKindClip:
		if !entranceSoundURLPattern.MatchString(sel.SoundURL) {
			s.skip("unexpected clip url", userID, nil)
			return
		}
		event.SoundURL = sel.SoundURL
		duration = sel.DurationMs
	case models.EntranceKindPreset:
		p, _, err := models.ValidateEntrancePreset([]byte(sel.Preset))
		if err != nil {
			s.skip("stored preset invalid", userID, err)
			return
		}
		event.Preset = &p
		duration = p.DurationMs
	default:
		return
	}
	event.PlayMs = min(duration, settings.MaxDurationMs)

	// The join may have been undone (leave, switch) while the gates ran.
	if vs := s.voice.GetUserVoiceState(userID); vs == nil || vs.ChannelID != channelID {
		s.skip("no longer in channel", userID, nil)
		return
	}
	participants := s.voice.GetChannelParticipants(channelID)
	recipients := make([]string, 0, len(participants))
	for _, p := range participants {
		recipients = append(recipients, p.UserID)
	}

	if !s.claimCooldown(userID) {
		return
	}
	s.hub.BroadcastToUsers(recipients, ws.Event{Op: ws.OpEntranceSoundPlay, Data: event})
}

func (s *entranceService) recentlyPlayed(userID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	last, ok := s.lastPlayed[userID]
	return ok && s.nowFn().Sub(last) < models.EntranceCooldown
}

// claimCooldown records a broadcast for userID unless another join claimed
// the window first (two joins racing through the gates broadcast once).
// Prunes expired entries once the map reaches entranceCooldownPruneAt.
func (s *entranceService) claimCooldown(userID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.nowFn()
	if last, ok := s.lastPlayed[userID]; ok && now.Sub(last) < models.EntranceCooldown {
		return false
	}
	if len(s.lastPlayed) >= entranceCooldownPruneAt {
		for id, t := range s.lastPlayed {
			if now.Sub(t) >= models.EntranceCooldown {
				delete(s.lastPlayed, id)
			}
		}
	}
	s.lastPlayed[userID] = now
	return true
}

func (s *entranceService) skip(reason, userID string, err error) {
	if err != nil {
		entranceLogger.Debug("entrance sound skipped", "reason", reason, "user_id", userID, "err", pkg.ErrText(err))
		return
	}
	entranceLogger.Debug("entrance sound skipped", "reason", reason, "user_id", userID)
}
