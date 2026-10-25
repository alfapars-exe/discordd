package services

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/testutil"
)

type recordingVoiceChannelDeletionHandler struct {
	called         int
	serverID       string
	channelID      string
	deleteComplete *bool
	calledAfterDB  bool
}

func (h *recordingVoiceChannelDeletionHandler) DeleteVoiceChannel(_ context.Context, serverID, channelID string) {
	h.called++
	h.serverID = serverID
	h.channelID = channelID
	if h.deleteComplete != nil {
		h.calledAfterDB = *h.deleteComplete
	}
}

func TestChannelDeleteCleansVoiceOnlyAfterRepositoryDeleteSucceeds(t *testing.T) {
	for _, tc := range []struct {
		name      string
		deleteErr error
		wantCalls int
	}{
		{name: "repository failure", deleteErr: errors.New("db unavailable"), wantCalls: 0},
		{name: "successful delete", wantCalls: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			deleteComplete := false
			repo := &testutil.MockChannelRepo{
				GetByIDFn: func(context.Context, string) (*models.Channel, error) {
					return &models.Channel{ID: "voice-1", ServerID: "server-1", Type: models.ChannelTypeVoice}, nil
				},
				DeleteFn: func(context.Context, string) error {
					if tc.deleteErr != nil {
						return tc.deleteErr
					}
					deleteComplete = true
					return nil
				},
			}
			handler := &recordingVoiceChannelDeletionHandler{deleteComplete: &deleteComplete}
			service := NewChannelService(repo, nil, &testutil.MockBroadcaster{}, nil, nil, nil, &testutil.MockNotificationRepo{}).(*channelService)
			service.SetVoiceChannelDeletionHandler(handler)

			err := service.Delete(context.Background(), "server-1", "actor-1", "voice-1")
			if tc.deleteErr != nil && !errors.Is(err, tc.deleteErr) {
				t.Fatalf("Delete() error = %v, want %v", err, tc.deleteErr)
			}
			if handler.called != tc.wantCalls {
				t.Fatalf("voice cleanup calls = %d, want %d", handler.called, tc.wantCalls)
			}
			if tc.wantCalls > 0 && (handler.serverID != "server-1" || handler.channelID != "voice-1" || !handler.calledAfterDB) {
				t.Fatalf("cleanup scope/order = (%q, %q, afterDB=%v)", handler.serverID, handler.channelID, handler.calledAfterDB)
			}
		})
	}
}
