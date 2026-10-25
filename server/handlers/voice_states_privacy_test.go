package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/models"
)

type voiceStatesServiceStub struct{ states []models.VoiceState }

func (*voiceStatesServiceStub) GenerateToken(context.Context, string, string, string, string) (*models.VoiceTokenResponse, error) {
	return nil, nil
}
func (*voiceStatesServiceStub) GenerateScreenShareToken(context.Context, string, string, string, string) (*models.VoiceTokenResponse, error) {
	return nil, nil
}
func (s *voiceStatesServiceStub) GetAllVoiceStates() []models.VoiceState { return s.states }

type voiceStatesFilterStub struct {
	wantViewer string
	serverID   string
	err        error
}

func (s voiceStatesFilterStub) FilterVisibleVoiceStates(_ context.Context, viewerID string, serverIDs []string, states []models.VoiceState) ([]models.VoiceState, error) {
	if viewerID != s.wantViewer || len(serverIDs) != 1 || serverIDs[0] != s.serverID {
		return nil, errors.New("unexpected filter scope")
	}
	if s.err != nil {
		return nil, s.err
	}
	out := make([]models.VoiceState, 0, len(states))
	for _, state := range states {
		if state.ServerID == s.serverID {
			out = append(out, state)
		}
	}
	return out, nil
}

func voiceStatesRequest(serverID string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, "/api/servers/"+serverID+"/voice/states", nil)
	ctx := context.WithValue(req.Context(), UserContextKey, &models.User{ID: "viewer"})
	ctx = context.WithValue(ctx, ServerIDContextKey, serverID)
	return req.WithContext(ctx)
}

func TestVoiceStatesFiltersToRequestedServerAndViewer(t *testing.T) {
	filter := voiceStatesFilterStub{wantViewer: "viewer", serverID: "server-a"}
	h := NewVoiceHandler(&voiceStatesServiceStub{states: []models.VoiceState{
		{UserID: "visible", ServerID: "server-a", ChannelID: "voice-a"},
		{UserID: "foreign", ServerID: "server-b", ChannelID: "voice-b"},
	}}, filter)
	rr := httptest.NewRecorder()
	h.VoiceStates(rr, voiceStatesRequest("server-a"))

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rr.Code, rr.Body.String())
	}
	var response struct {
		Success bool                `json:"success"`
		Data    []models.VoiceState `json:"data"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !response.Success || len(response.Data) != 1 || response.Data[0].UserID != "visible" || response.Data[0].ServerID != "server-a" {
		t.Fatalf("states = %+v, want only requested server state", response.Data)
	}
}

func TestVoiceStatesFailsClosedOnFilterErrorOrMissingFilter(t *testing.T) {
	for _, tc := range []struct {
		name   string
		filter VoiceStateSnapshotFilter
	}{
		{name: "filter error", filter: voiceStatesFilterStub{wantViewer: "viewer", serverID: "server-a", err: errors.New("permission lookup failed")}},
		{name: "filter missing"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := NewVoiceHandler(&voiceStatesServiceStub{states: []models.VoiceState{{UserID: "secret", ServerID: "server-a", ChannelID: "private"}}})
			if tc.filter != nil {
				h = NewVoiceHandler(h.voiceService, tc.filter)
			}
			rr := httptest.NewRecorder()
			h.VoiceStates(rr, voiceStatesRequest("server-a"))
			if rr.Code != http.StatusInternalServerError {
				t.Fatalf("status = %d, want 500", rr.Code)
			}
			if strings.Contains(rr.Body.String(), "secret") {
				t.Fatalf("error response leaked voice state: %q", rr.Body.String())
			}
		})
	}
}

func TestVoiceStatesRequiresViewerAndServerScope(t *testing.T) {
	h := NewVoiceHandler(&voiceStatesServiceStub{}, voiceStatesFilterStub{wantViewer: "viewer", serverID: "server-a"})
	t.Run("viewer", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/servers/server-a/voice/states", nil)
		req = req.WithContext(context.WithValue(req.Context(), ServerIDContextKey, "server-a"))
		rr := httptest.NewRecorder()
		h.VoiceStates(rr, req)
		if rr.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", rr.Code)
		}
	})
	t.Run("server", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/servers/server-a/voice/states", nil)
		req = req.WithContext(context.WithValue(req.Context(), UserContextKey, &models.User{ID: "viewer"}))
		rr := httptest.NewRecorder()
		h.VoiceStates(rr, req)
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", rr.Code)
		}
	})
}
