package services

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/argeinfina/hichat/models"
)

type clipVoiceStub struct{ states map[string]models.VoiceState }

func (s clipVoiceStub) GetUserVoiceState(userID string) *models.VoiceState {
	state, ok := s.states[userID]
	if !ok {
		return nil
	}
	copy := state
	return &copy
}
func (s clipVoiceStub) GetChannelParticipants(channelID string) []models.VoiceState {
	var out []models.VoiceState
	for _, state := range s.states {
		if state.ChannelID == channelID {
			out = append(out, state)
		}
	}
	return out
}

type clipPrefsStub struct{ consent map[string]bool }

func (s clipPrefsStub) Get(_ context.Context, userID string) (*models.UserPreferences, error) {
	data, _ := json.Marshal(map[string]any{"privacy": map[string]any{"clipVoiceConsent": s.consent[userID]}})
	return &models.UserPreferences{Data: data}, nil
}

type clipLogStub struct{ messages []string }

func (s *clipLogStub) Log(_ context.Context, _ models.LogLevel, _ models.LogCategory, _, _ *string, message string, _ map[string]string) {
	s.messages = append(s.messages, message)
}
func (*clipLogStub) List(context.Context, models.AppLogFilter) ([]models.AppLog, int, error) {
	return nil, 0, nil
}
func (*clipLogStub) Clear(context.Context) error { return nil }
func (*clipLogStub) Start()                      {}
func (*clipLogStub) Stop()                       {}

func TestClipRecordingConsentAndLifecycle(t *testing.T) {
	voice := clipVoiceStub{states: map[string]models.VoiceState{
		"owner":   {UserID: "owner", ServerID: "s1", ChannelID: "c1"},
		"allowed": {UserID: "allowed", ServerID: "s1", ChannelID: "c1"},
		"denied":  {UserID: "denied", ServerID: "s1", ChannelID: "c1"},
	}}
	prefs := clipPrefsStub{consent: map[string]bool{"owner": true, "allowed": true, "denied": false}}
	logs := &clipLogStub{}
	service := NewClipRecordingService(voice, prefs, logs)

	started, err := service.Start(context.Background(), "owner", "s1", "c1")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if started.RecordingID == "" {
		t.Fatal("missing recording id")
	}
	if len(started.IncludedUserIDs) != 2 || len(started.ExcludedUserIDs) != 1 || started.ExcludedUserIDs[0] != "denied" {
		t.Fatalf("snapshot = %+v", started)
	}
	if err := service.Stop(context.Background(), "owner", "s1", "c1", started.RecordingID, 1234); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if len(logs.messages) != 2 || logs.messages[0] != "clip_recording_started" || logs.messages[1] != "clip_recording_stopped" {
		t.Fatalf("logs = %v", logs.messages)
	}
}

func TestClipRecordingRejectsRecorderOutsideChannel(t *testing.T) {
	service := NewClipRecordingService(clipVoiceStub{states: map[string]models.VoiceState{}}, clipPrefsStub{}, nil)
	if _, err := service.Start(context.Background(), "owner", "s1", "c1"); err == nil {
		t.Fatal("expected forbidden error")
	}
}
