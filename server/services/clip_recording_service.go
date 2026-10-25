package services

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

type clipVoiceStateReader interface {
	GetUserVoiceState(string) *models.VoiceState
	GetChannelParticipants(string) []models.VoiceState
}

type clipSession struct {
	ownerID   string
	serverID  string
	channelID string
}

type ClipRecordingService interface {
	Snapshot(context.Context, string, string, string) (*models.ClipConsentSnapshot, error)
	Start(context.Context, string, string, string) (*models.ClipConsentSnapshot, error)
	Stop(context.Context, string, string, string, string, int64) error
}

type clipRecordingService struct {
	voice    clipVoiceStateReader
	prefs    profilePreferenceReader
	logger   AppLogService
	mu       sync.Mutex
	sessions map[string]clipSession
	byOwner  map[string]string
}

func NewClipRecordingService(voice clipVoiceStateReader, prefs profilePreferenceReader, logger AppLogService) ClipRecordingService {
	return &clipRecordingService{voice: voice, prefs: prefs, logger: logger, sessions: map[string]clipSession{}, byOwner: map[string]string{}}
}

func (s *clipRecordingService) Snapshot(ctx context.Context, ownerID, serverID, channelID string) (*models.ClipConsentSnapshot, error) {
	state := s.voice.GetUserVoiceState(ownerID)
	if state == nil || state.ServerID != serverID || state.ChannelID != channelID {
		return nil, fmt.Errorf("%w: recorder is not in this voice channel", pkg.ErrForbidden)
	}
	participants := s.voice.GetChannelParticipants(channelID)
	included := make([]string, 0, len(participants))
	excluded := make([]string, 0, len(participants))
	for _, participant := range participants {
		prefs, err := s.prefs.Get(ctx, participant.UserID)
		if err != nil {
			return nil, err
		}
		consented := false
		var data struct {
			Privacy struct {
				ClipVoiceConsent bool `json:"clipVoiceConsent"`
			} `json:"privacy"`
		}
		if len(prefs.Data) > 0 {
			if err := json.Unmarshal(prefs.Data, &data); err != nil {
				return nil, err
			}
			consented = data.Privacy.ClipVoiceConsent
		}
		if consented {
			included = append(included, participant.UserID)
		} else {
			excluded = append(excluded, participant.UserID)
		}
	}
	sort.Strings(included)
	sort.Strings(excluded)
	return &models.ClipConsentSnapshot{IncludedUserIDs: included, ExcludedUserIDs: excluded}, nil
}

func (s *clipRecordingService) Start(ctx context.Context, ownerID, serverID, channelID string) (*models.ClipConsentSnapshot, error) {
	snapshot, err := s.Snapshot(ctx, ownerID, serverID, channelID)
	if err != nil {
		return nil, err
	}
	id, err := clipRecordingID()
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	if previous := s.byOwner[ownerID]; previous != "" {
		delete(s.sessions, previous)
	}
	s.sessions[id] = clipSession{ownerID: ownerID, serverID: serverID, channelID: channelID}
	s.byOwner[ownerID] = id
	s.mu.Unlock()
	snapshot.RecordingID = id
	s.log(ctx, ownerID, serverID, "clip_recording_started", map[string]string{
		"recording_id": id, "channel_id": channelID,
		"included_user_ids": strings.Join(snapshot.IncludedUserIDs, ","),
		"excluded_user_ids": strings.Join(snapshot.ExcludedUserIDs, ","),
	})
	return snapshot, nil
}

func (s *clipRecordingService) Stop(ctx context.Context, ownerID, serverID, channelID, recordingID string, durationMS int64) error {
	if durationMS < 0 || durationMS > 60*60*1000 {
		return fmt.Errorf("%w: invalid clip duration", pkg.ErrBadRequest)
	}
	s.mu.Lock()
	session, ok := s.sessions[recordingID]
	if ok && session.ownerID == ownerID && session.serverID == serverID && session.channelID == channelID {
		delete(s.sessions, recordingID)
		delete(s.byOwner, ownerID)
	}
	s.mu.Unlock()
	if !ok || session.ownerID != ownerID || session.serverID != serverID || session.channelID != channelID {
		return fmt.Errorf("%w: recording session not found", pkg.ErrNotFound)
	}
	snapshot, err := s.Snapshot(ctx, ownerID, serverID, channelID)
	if err != nil {
		return err
	}
	s.log(ctx, ownerID, serverID, "clip_recording_stopped", map[string]string{
		"recording_id": recordingID, "channel_id": channelID,
		"duration_ms":             strconv.FormatInt(durationMS, 10),
		"final_included_user_ids": strings.Join(snapshot.IncludedUserIDs, ","),
		"final_excluded_user_ids": strings.Join(snapshot.ExcludedUserIDs, ","),
	})
	return nil
}

func (s *clipRecordingService) log(ctx context.Context, userID, serverID, message string, metadata map[string]string) {
	if s.logger != nil {
		s.logger.Log(ctx, models.LogLevelInfo, models.LogCategoryVoice, &userID, &serverID, message, metadata)
	}
}

func clipRecordingID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
