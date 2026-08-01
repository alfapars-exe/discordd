package services

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"mime/multipart"
	"os"
	"path/filepath"
	"strings"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
	"github.com/google/uuid"
)

var soundboardLogger = logx.Component("service.soundboard")

const (
	maxSoundDurationMs = 7000 // 7 seconds
	maxSoundsPerServer = 50
	soundboardSubdir   = "soundboard"
)

var soundAllowedMimeTypes = map[string]bool{
	"audio/mpeg":  true,
	"audio/ogg":   true,
	"audio/wav":   true,
	"audio/webm":  true,
	"audio/mp4":   true,
	"audio/x-m4a": true,
	"audio/aac":   true,
	"video/mp4":   true, // frontend extracts audio and converts to WAV before upload; kept as fallback
}

// soundAllowedSniffedTypes gates on what http.DetectContentType actually
// reports for the byte-content-derived (never client-claimed) MIME, after
// pkg.RefineMIME's generic-result cleanup. Note the values Go's sniffer
// really returns for audio, which do NOT match the client-facing map above:
// RIFF/WAVE sniffs as "audio/wave" (not "audio/wav"), OGG containers as
// "audio/ogg"/"application/ogg", and WebM/MP4 containers carrying only an
// audio track still sniff as the video container types since the sniffer
// has no audio-only WebM/MP4 signature.
var soundAllowedSniffedTypes = map[string]bool{
	"audio/mpeg":      true,
	"audio/wave":      true,
	"audio/aiff":      true,
	"audio/basic":     true,
	"audio/ogg":       true,
	"application/ogg": true,
	"video/webm":      true,
	"video/mp4":       true,
	"audio/mp4":       true,
}

// soundGenericExts is the extension fallback for sniff results that come
// back "application/octet-stream" — Go's sniff dictionary has no AAC or M4A
// signature at all, and an ID3-less MP3 also sniffs as generic. Restricted
// to the containers the client is known to produce (the frontend converts
// captured audio to WAV before upload). Residual weakness: an attacker can
// still store unclassifiable binary bytes under one of these extensions —
// but every BYTE-classifiable type (text/html, image/*, application/pdf,
// ...) is now rejected regardless of what extension it's given, which is
// what closes off the "free file hosting" effect of an unchecked upload.
var soundGenericExts = map[string]bool{
	"mp3":  true,
	"aac":  true,
	"m4a":  true,
	"wav":  true,
	"ogg":  true,
	"webm": true,
	"mp4":  true,
}

// VoiceStateGetter retrieves a user's current voice state.
type VoiceStateGetter interface {
	GetUserVoiceState(userID string) *models.VoiceState
	GetChannelParticipants(channelID string) []models.VoiceState
}

// SoundboardService manages soundboard sounds per server.
type SoundboardService interface {
	List(ctx context.Context, serverID string) ([]models.SoundboardSound, error)
	Get(ctx context.Context, id string) (*models.SoundboardSound, error)
	Create(ctx context.Context, serverID, userID string, req *models.CreateSoundboardSoundRequest, file multipart.File, header *multipart.FileHeader, durationMs int) (*models.SoundboardSound, error)
	Update(ctx context.Context, serverID, id string, req *models.UpdateSoundboardSoundRequest) (*models.SoundboardSound, error)
	Delete(ctx context.Context, serverID, id string) error
	Play(ctx context.Context, serverID, soundID, userID, username string) error
}

type soundboardService struct {
	repo      repository.SoundboardRepository
	userRepo  repository.UserRepository
	hub       ws.Broadcaster
	voice     VoiceStateGetter
	uploadDir string
	maxSize   int64
}

func NewSoundboardService(
	repo repository.SoundboardRepository,
	userRepo repository.UserRepository,
	hub ws.Broadcaster,
	voice VoiceStateGetter,
	uploadDir string,
	maxSize int64,
) SoundboardService {
	// Ensure soundboard upload directory exists. 0750 matches the main
	// upload dir — group-readable for the operator's diagnostic tools,
	// closed off from "other" so a shared host doesn't leak audio clips.
	dir := filepath.Join(uploadDir, soundboardSubdir)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		soundboardLogger.Warn("failed to create soundboard dir", "dir", dir, "err", pkg.ErrText(err))
	}

	return &soundboardService{
		repo:      repo,
		userRepo:  userRepo,
		hub:       hub,
		voice:     voice,
		uploadDir: uploadDir,
		maxSize:   maxSize,
	}
}

func (s *soundboardService) List(ctx context.Context, serverID string) ([]models.SoundboardSound, error) {
	sounds, err := s.repo.ListByServer(ctx, serverID)
	if err != nil {
		return nil, fmt.Errorf("list soundboard sounds: %w", err)
	}
	if sounds == nil {
		sounds = []models.SoundboardSound{}
	}
	return sounds, nil
}

func (s *soundboardService) Get(ctx context.Context, id string) (*models.SoundboardSound, error) {
	return s.repo.GetByID(ctx, id)
}

func (s *soundboardService) Create(
	ctx context.Context,
	serverID, userID string,
	req *models.CreateSoundboardSoundRequest,
	file multipart.File,
	header *multipart.FileHeader,
	durationMs int,
) (*models.SoundboardSound, error) {
	if durationMs <= 0 || durationMs > maxSoundDurationMs {
		return nil, fmt.Errorf("%w: duration must be between 1 and %d ms", pkg.ErrBadRequest, maxSoundDurationMs)
	}

	if strings.TrimSpace(req.Name) == "" {
		return nil, fmt.Errorf("%w: name is required", pkg.ErrBadRequest)
	}

	if header.Size > s.maxSize {
		return nil, fmt.Errorf("%w: file too large", pkg.ErrBadRequest)
	}

	// Cheap pre-filter on the client-claimed Content-Type — harmless to keep,
	// but NOT the security boundary: the client fully controls this header.
	contentType := header.Header.Get("Content-Type")
	mimeBase := strings.Split(contentType, ";")[0]
	mimeBase = strings.TrimSpace(mimeBase)
	if !soundAllowedMimeTypes[mimeBase] {
		return nil, fmt.Errorf("%w: audio file type not allowed: %s", pkg.ErrBadRequest, mimeBase)
	}

	// The real gate: sniff the actual bytes. replay MUST be what's written
	// to disk below — SniffContentType consumes up to 512 bytes from file,
	// so writing file itself would silently truncate the upload.
	sniffed, replay, err := pkg.SniffContentType(file)
	if err != nil {
		return nil, fmt.Errorf("%w: unreadable upload", pkg.ErrBadRequest)
	}
	refined := pkg.RefineMIME(sniffed, header.Filename)
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(header.Filename), "."))
	// Two ways in: the bytes sniff as a known audio type, or they sniff as
	// nothing in particular and the extension is one Go's sniffer has no
	// signature for (aac/m4a). Stated positively so the acceptance rule reads
	// as a rule rather than as a pair of negations.
	accepted := soundAllowedSniffedTypes[refined] ||
		(sniffed == "application/octet-stream" && soundGenericExts[ext])
	if !accepted {
		return nil, fmt.Errorf("%w: file contents are not audio", pkg.ErrBadRequest)
	}

	count, err := s.repo.CountByServer(ctx, serverID)
	if err != nil {
		return nil, fmt.Errorf("count sounds: %w", err)
	}
	if count >= maxSoundsPerServer {
		return nil, fmt.Errorf("%w: server has reached the maximum of %d sounds", pkg.ErrBadRequest, maxSoundsPerServer)
	}

	// Save file to disk
	randomBytes := make([]byte, 8)
	if _, err := rand.Read(randomBytes); err != nil {
		return nil, fmt.Errorf("generate random filename: %w", err)
	}
	safeFilename := sanitizeFilename(header.Filename)
	diskFilename := hex.EncodeToString(randomBytes) + "_" + safeFilename
	dir := filepath.Join(s.uploadDir, soundboardSubdir)
	destPath, err := pkg.SafeJoin(dir, diskFilename)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid upload destination", pkg.ErrBadRequest)
	}

	if err := writeUploadFile(destPath, replay, "create file", "save file", "finalize file"); err != nil {
		return nil, err
	}

	sound := &models.SoundboardSound{
		ID:         uuid.New().String(),
		ServerID:   serverID,
		Name:       strings.TrimSpace(req.Name),
		Emoji:      req.Emoji,
		FileURL:    "/api/uploads/" + soundboardSubdir + "/" + diskFilename,
		FileSize:   header.Size,
		DurationMs: durationMs,
		UploadedBy: userID,
	}

	if err := s.repo.Create(ctx, sound); err != nil {
		os.Remove(destPath)
		return nil, fmt.Errorf("create sound record: %w", err)
	}

	// Fetch with joined user info
	created, err := s.repo.GetByID(ctx, sound.ID)
	if err != nil {
		return sound, nil
	}

	s.hub.BroadcastToServer(serverID, ws.Event{
		Op:   ws.OpSoundboardCreate,
		Data: created,
	})

	return created, nil
}

func (s *soundboardService) Update(ctx context.Context, serverID, id string, req *models.UpdateSoundboardSoundRequest) (*models.SoundboardSound, error) {
	sound, err := s.repo.GetByID(ctx, id)
	if err != nil {
		return nil, err
	}

	// Cross-tenant guard: a sound fetched by ID must actually belong to the
	// server in the URL, otherwise the caller could edit a sound living on a
	// server they don't have ManageSoundboard on. ErrNotFound (not
	// ErrBadRequest) so cross-tenant existence isn't leaked — mirrors
	// resolveChannelInServer.
	if sound.ServerID != serverID {
		return nil, fmt.Errorf("%w: sound not found", pkg.ErrNotFound)
	}

	if req.Name != nil {
		name := strings.TrimSpace(*req.Name)
		if name == "" {
			return nil, fmt.Errorf("%w: name cannot be empty", pkg.ErrBadRequest)
		}
		sound.Name = name
	}
	if req.Emoji != nil {
		sound.Emoji = req.Emoji
	}

	if err := s.repo.Update(ctx, sound); err != nil {
		return nil, fmt.Errorf("update sound: %w", err)
	}

	updated, _ := s.repo.GetByID(ctx, id)
	if updated == nil {
		updated = sound
	}

	s.hub.BroadcastToServer(sound.ServerID, ws.Event{
		Op:   ws.OpSoundboardUpdate,
		Data: updated,
	})

	return updated, nil
}

func (s *soundboardService) Delete(ctx context.Context, serverID, id string) error {
	sound, err := s.repo.GetByID(ctx, id)
	if err != nil {
		return err
	}

	// Cross-tenant guard: must run before the disk delete below, otherwise a
	// caller with ManageSoundboard on server A could delete an audio file
	// belonging to server B by guessing its soundID.
	if sound.ServerID != serverID {
		return fmt.Errorf("%w: sound not found", pkg.ErrNotFound)
	}

	// Delete file from disk
	if sound.FileURL != "" {
		relPath := strings.TrimPrefix(sound.FileURL, "/api/uploads/")
		diskPath := filepath.Join(s.uploadDir, relPath)
		os.Remove(diskPath)
	}

	if err := s.repo.Delete(ctx, id); err != nil {
		return fmt.Errorf("delete sound: %w", err)
	}

	s.hub.BroadcastToServer(sound.ServerID, ws.Event{
		Op:   ws.OpSoundboardDelete,
		Data: map[string]string{"id": id, "server_id": sound.ServerID},
	})

	return nil
}

func (s *soundboardService) Play(ctx context.Context, serverID, soundID, userID, username string) error {
	// User must be in a voice channel
	voiceState := s.voice.GetUserVoiceState(userID)
	if voiceState == nil {
		return fmt.Errorf("%w: you must be in a voice channel to play sounds", pkg.ErrBadRequest)
	}

	sound, err := s.repo.GetByID(ctx, soundID)
	if err != nil {
		return err
	}

	if sound.ServerID != serverID {
		return fmt.Errorf("%w: sound does not belong to this server", pkg.ErrBadRequest)
	}

	// Broadcast only to users in the same voice channel
	participants := s.voice.GetChannelParticipants(voiceState.ChannelID)
	userIDs := make([]string, 0, len(participants))
	for _, p := range participants {
		userIDs = append(userIDs, p.UserID)
	}

	s.hub.BroadcastToUsers(userIDs, ws.Event{
		Op: ws.OpSoundboardPlay,
		Data: models.SoundboardPlayEvent{
			SoundID:   sound.ID,
			SoundName: sound.Name,
			SoundURL:  sound.FileURL,
			UserID:    userID,
			Username:  username,
			ServerID:  serverID,
			ChannelID: voiceState.ChannelID,
		},
	})

	return nil
}
