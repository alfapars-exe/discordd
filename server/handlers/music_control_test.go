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
	"github.com/argeinfina/hichat/services"
)

type musicControlStub struct {
	stubMusicService
	adopted    bool
	commands   []services.MusicCommand
	adoptions  int
	stateReads int
	stateErr   error
}

func (s *musicControlStub) GetStateWithError(context.Context, string) (*models.MusicBotChannelState, error) {
	if s.stateErr != nil {
		return nil, s.stateErr
	}
	return s.GetState("ch"), nil
}

func (s *musicControlStub) AdoptControl(context.Context, string) (models.MusicControlHead, error) {
	s.adopted = true
	s.adoptions++
	return models.MusicControlHead{ChannelID: "ch", ServerID: "srv", SessionID: "session", MinimumProtocol: 2}, nil
}
func (s *musicControlStub) CheckLegacyControl(context.Context, string) error {
	if s.adopted {
		return services.ErrMusicProtocolRequired
	}
	return nil
}
func (s *musicControlStub) ApplyMusicCommand(_ context.Context, _, _ string, c services.MusicCommand) (json.RawMessage, error) {
	s.commands = append(s.commands, c)
	return json.RawMessage(`{"status":"ok"}`), nil
}
func (s *musicControlStub) GetState(string) *models.MusicBotChannelState { s.stateReads++; return nil }

type musicAccessChannel struct{ channel models.Channel }

func (c musicAccessChannel) GetByID(context.Context, string) (*models.Channel, error) {
	return &c.channel, nil
}

type musicAccessVoice string

func (v musicAccessVoice) GetUserVoiceChannelID(string) string { return string(v) }

type musicAccessPerm models.Permission

func (p musicAccessPerm) ResolveChannelPermissions(context.Context, string, string) (models.Permission, error) {
	return models.Permission(p), nil
}
func (p musicAccessPerm) ResolveChannelPermissionsBulk(context.Context, string, []string) (map[string]models.Permission, error) {
	return nil, nil
}

func musicControlRequest(method, body string) *http.Request {
	r := httptest.NewRequest(method, "/api/servers/srv/channels/ch/music/skip", strings.NewReader(body))
	r.SetPathValue("serverId", "srv")
	r.SetPathValue("channelId", "ch")
	return r.WithContext(context.WithValue(r.Context(), UserContextKey, &models.User{ID: "human"}))
}

func TestMusicControlMetadataCannotDowngradeAdoptedChannel(t *testing.T) {
	for _, body := range []string{`{}`, `{"session_id":"session"}`, `{"request_id":"request","expected_revision":0}`} {
		svc := &musicControlStub{adopted: true}
		h := NewMusicHandler(svc, stubPermResolver{}, nil)
		w := httptest.NewRecorder()
		h.Skip(w, musicControlRequest(http.MethodPost, body))
		if w.Code != 428 || len(svc.commands) != 0 {
			t.Fatalf("body=%s status=%d commands=%d", body, w.Code, len(svc.commands))
		}
	}
	svc := &musicControlStub{adopted: true}
	h := NewMusicHandler(svc, stubPermResolver{}, nil)
	w := httptest.NewRecorder()
	h.Skip(w, musicControlRequest(http.MethodPost, `{"session_id":"session","request_id":"request","expected_revision":0,"expected_queue_item_id":""}`))
	if w.Code != 200 || len(svc.commands) != 1 || svc.commands[0].ExpectedRevision == nil || *svc.commands[0].ExpectedRevision != 0 || svc.commands[0].ExpectedQueueItemID == nil {
		t.Fatalf("zero revision metadata lost: %d %#v", w.Code, svc.commands)
	}
}

func TestMusicControlChannelViewServerTypeAndVoiceGates(t *testing.T) {
	for _, tc := range []struct {
		name, voice, server string
		kind                models.ChannelType
		permission          models.Permission
		read, stop          bool
		want                int
	}{
		{name: "normal listener", voice: "ch", server: "srv", kind: models.ChannelTypeVoice, permission: models.PermViewChannel | models.PermSpeak, want: 200},
		{name: "other voice denied", voice: "another", server: "srv", kind: models.ChannelTypeVoice, permission: models.PermViewChannel | models.PermSpeak, want: 403},
		{name: "private hidden denied", voice: "ch", server: "srv", kind: models.ChannelTypeVoice, permission: models.PermSpeak, want: 403},
		{name: "cross server denied", voice: "ch", server: "other", kind: models.ChannelTypeVoice, permission: models.PermAll, want: 403},
		{name: "text channel denied", voice: "ch", server: "srv", kind: models.ChannelTypeText, permission: models.PermAll, want: 403},
		{name: "remote moderator stop retained", voice: "another", server: "srv", kind: models.ChannelTypeVoice, permission: models.PermViewChannel | models.PermManageChannels, stop: true, want: 200},
		{name: "remote moderator cannot inject", voice: "another", server: "srv", kind: models.ChannelTypeVoice, permission: models.PermAll, want: 403},
		{name: "read does not require voice", voice: "another", server: "srv", kind: models.ChannelTypeVoice, permission: models.PermViewChannel, read: true, want: 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc := &musicControlStub{adopted: true}
			h := NewMusicHandler(svc, musicAccessPerm(tc.permission), nil, MusicAccessDependencies{Channels: musicAccessChannel{models.Channel{ID: "ch", ServerID: tc.server, Type: tc.kind}}, Voice: musicAccessVoice(tc.voice)})
			w := httptest.NewRecorder()
			r := musicControlRequest(http.MethodPost, `{"session_id":"session","request_id":"request","expected_revision":0,"expected_queue_item_id":""}`)
			switch {
			case tc.read:
				h.State(w, r)
			case tc.stop:
				h.Stop(w, r)
			default:
				h.Skip(w, r)
			}
			if w.Code != tc.want {
				t.Fatalf("status=%d want=%d body=%s", w.Code, tc.want, w.Body.String())
			}
			if svc.adoptions != 0 {
				t.Fatal("read/command silently adopted protocol")
			}
		})
	}
}

func TestMusicControlStateDoesNotAdoptAndRejectsBotIdentity(t *testing.T) {
	svc := &musicControlStub{}
	h := NewMusicHandler(svc, stubPermResolver{}, nil)
	w := httptest.NewRecorder()
	r := musicControlRequest(http.MethodGet, "")
	h.State(w, r)
	if w.Code != 200 || svc.adoptions != 0 || svc.adopted {
		t.Fatalf("read mutated adoption: status=%d", w.Code)
	}
	r = r.WithContext(context.WithValue(r.Context(), UserContextKey, &models.User{ID: "bot", IsBot: true}))
	w = httptest.NewRecorder()
	h.AdoptControl(w, r)
	if w.Code != 403 || svc.adoptions != 0 {
		t.Fatalf("bot adopted music control: status=%d", w.Code)
	}
}

func TestMusicControlStateStoreFailureIsNotEmptySuccess(t *testing.T) {
	svc := &musicControlStub{stateErr: errors.New("private database path: unavailable")}
	h := NewMusicHandler(svc, stubPermResolver{}, nil)
	w := httptest.NewRecorder()
	h.State(w, musicControlRequest(http.MethodGet, ""))
	if w.Code != 500 || strings.Contains(w.Body.String(), "private database path") || svc.adoptions != 0 || svc.stateReads != 0 {
		t.Fatalf("failed state lookup became empty success: status=%d body=%s", w.Code, w.Body.String())
	}
}
