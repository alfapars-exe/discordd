package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
)

type musicScopeVoice struct{ state *models.VoiceState }

func (v *musicScopeVoice) GetUserVoiceState(string) *models.VoiceState {
	if v.state == nil {
		return nil
	}
	copy := *v.state
	return &copy
}
func (v *musicScopeVoice) GetUserVoiceChannelID(string) string {
	if v.state == nil {
		return ""
	}
	return v.state.ChannelID
}

type musicScopeSessions struct {
	err              error
	actors, sessions []string
}

func (s *musicScopeSessions) ValidateSession(_ context.Context, actor, sid string) error {
	s.actors = append(s.actors, actor)
	s.sessions = append(s.sessions, sid)
	return s.err
}

type musicScopeMembers struct{ member bool }

func (m *musicScopeMembers) IsMember(context.Context, string, string) (bool, error) {
	return m.member, nil
}

type musicScopeChannel struct{ channel models.Channel }

func (c *musicScopeChannel) GetByID(context.Context, string) (*models.Channel, error) {
	copy := c.channel
	return &copy, nil
}

type musicScopePerms struct {
	stubPermResolver
	fresh      models.Permission
	freshCalls int
}

func (p *musicScopePerms) ResolveChannelPermissionsFresh(context.Context, string, string) (models.Permission, error) {
	p.freshCalls++
	return p.fresh, nil
}

type musicScopeLegacyService struct {
	stubMusicService
	work  func(context.Context) error
	actor string
}

func (s *musicScopeLegacyService) Enqueue(ctx context.Context, actor, _, _ string) ([]models.MusicTrack, error) {
	s.actor = actor
	return nil, s.work(ctx)
}
func (s *musicScopeLegacyService) Restore(ctx context.Context, _ string) error { return s.work(ctx) }

type musicScopeGuardService struct{ musicScopeLegacyService }

func (*musicScopeGuardService) AdoptControl(context.Context, string) (models.MusicControlHead, error) {
	return models.MusicControlHead{}, nil
}
func (*musicScopeGuardService) CheckLegacyControl(context.Context, string) error { return nil }
func (s *musicScopeGuardService) ApplyMusicCommand(ctx context.Context, actor, _ string, _ services.MusicCommand) (json.RawMessage, error) {
	s.actor = actor
	if err := s.work(ctx); err != nil {
		return nil, err
	}
	return json.RawMessage(`{"status":"ok"}`), nil
}

func TestMusicAccessScopeRechecksLegacyAndGuardedAfterAwait(t *testing.T) {
	for _, guarded := range []bool{false, true} {
		for _, change := range []string{"leave", "leave-rejoin", "admin-out-and-back", "same-session-reconnect", "channel-switch", "membership-revoked", "speak-revoked", "view-revoked", "channel-moved", "channel-type-changed", "session-revoked"} {
			t.Run(map[bool]string{false: "legacy/", true: "guarded/"}[guarded]+change, func(t *testing.T) {
				joined := time.Unix(1000, 123)
				voice := &musicScopeVoice{state: &models.VoiceState{UserID: "human", ChannelID: "ch", ServerID: "srv", JoinedAt: joined}}
				sessions := &musicScopeSessions{}
				members := &musicScopeMembers{member: true}
				channel := &musicScopeChannel{channel: models.Channel{ID: "ch", ServerID: "srv", Type: models.ChannelTypeVoice}}
				perms := &musicScopePerms{fresh: models.PermAll}
				work := func(ctx context.Context) error {
					switch change {
					case "leave":
						voice.state = nil
					case "leave-rejoin":
						voice.state.JoinedAt = joined.Add(time.Second)
					case "admin-out-and-back":
						voice.state.ChannelGeneration += 2
					case "same-session-reconnect":
						voice.state.DisplayName = "Refreshed"
					case "channel-switch":
						voice.state.ChannelID = "other"
					case "membership-revoked":
						members.member = false
					case "speak-revoked":
						perms.fresh = models.PermViewChannel
					case "view-revoked":
						perms.fresh = models.PermSpeak
					case "channel-moved":
						channel.channel.ServerID = "other"
					case "channel-type-changed":
						channel.channel.Type = models.ChannelTypeText
					case "session-revoked":
						sessions.err = pkg.ErrUnauthorized
					}
					return services.RecheckMusicAccess(ctx)
				}
				legacy := &musicScopeLegacyService{work: work}
				var music services.MusicBotService = legacy
				guard := &musicScopeGuardService{musicScopeLegacyService: musicScopeLegacyService{work: work}}
				if guarded {
					music = guard
				}
				h := NewMusicHandler(music, perms, nil, MusicAccessDependencies{Channels: channel, Voice: voice, Sessions: sessions, Members: members})
				body := `{"url":"https://youtu.be/0KbRhUtFwkc","actor_id":"forged-user"}`
				if guarded {
					body = `{"url":"https://youtu.be/0KbRhUtFwkc","actor_id":"forged-user","session_id":"00000000-0000-4000-8000-000000000001","request_id":"00000000-0000-4000-8000-000000000002","expected_revision":0}`
				}
				r := musicControlRequest(http.MethodPost, body)
				r = r.WithContext(context.WithValue(r.Context(), AuthSessionContextKey, "real-auth-session"))
				w := httptest.NewRecorder()
				h.Play(w, r)
				want := 403
				if change == "same-session-reconnect" {
					want = 200
				}
				if change == "session-revoked" {
					want = 401
				}
				if w.Code != want {
					t.Fatalf("status=%d want=%d body=%s", w.Code, want, w.Body.String())
				}
				actor := legacy.actor
				if guarded {
					actor = guard.actor
				}
				if actor != "human" || len(sessions.actors) != 1 || sessions.actors[0] != "human" || sessions.sessions[0] != "real-auth-session" {
					t.Fatalf("authorization identity changed: actor=%q auth=%#v/%#v", actor, sessions.actors, sessions.sessions)
				}
				if change == "speak-revoked" || change == "view-revoked" {
					if perms.freshCalls != 1 {
						t.Fatal("long-running work reused cached positive permission")
					}
				}
			})
		}
	}
}

func TestMusicAccessScopeRemoteModeratorStopAndLegacyRestore(t *testing.T) {
	voice := &musicScopeVoice{}
	sessions := &musicScopeSessions{}
	members := &musicScopeMembers{member: true}
	channel := &musicScopeChannel{channel: models.Channel{ID: "ch", ServerID: "srv", Type: models.ChannelTypeVoice}}
	perms := &musicScopePerms{fresh: models.PermViewChannel | models.PermManageChannels}
	guard := &musicScopeGuardService{musicScopeLegacyService: musicScopeLegacyService{work: services.RecheckMusicAccess}}
	h := NewMusicHandler(guard, perms, nil, MusicAccessDependencies{Channels: channel, Voice: voice, Sessions: sessions, Members: members})
	r := musicControlRequest(http.MethodPost, `{"session_id":"s","request_id":"r","expected_revision":0}`)
	r = r.WithContext(context.WithValue(r.Context(), AuthSessionContextKey, "real-auth-session"))
	w := httptest.NewRecorder()
	h.Stop(w, r)
	if w.Code != 200 || len(sessions.sessions) != 1 {
		t.Fatalf("remote moderator stop lost privilege: %d %s", w.Code, w.Body.String())
	}
	joined := time.Unix(1000, 1)
	voice.state = &models.VoiceState{UserID: "human", ChannelID: "ch", ServerID: "srv", JoinedAt: joined}
	perms.fresh = models.PermAll
	legacy := &musicScopeLegacyService{work: func(ctx context.Context) error {
		voice.state.JoinedAt = joined.Add(time.Second)
		return services.RecheckMusicAccess(ctx)
	}}
	h = NewMusicHandler(legacy, perms, nil, MusicAccessDependencies{Channels: channel, Voice: voice, Sessions: sessions, Members: members})
	r = musicControlRequest(http.MethodPost, "")
	w = httptest.NewRecorder()
	h.Restore(w, r)
	if w.Code != 403 {
		t.Fatalf("legacy restore crossed voice incarnation: %d %s", w.Code, w.Body.String())
	}
}

func TestMusicAccessScopeRejectsUnverifiableRealVoiceIncarnation(t *testing.T) {
	voice := &musicScopeVoice{state: &models.VoiceState{UserID: "human", ChannelID: "ch", ServerID: "srv"}}
	legacy := &musicScopeLegacyService{work: func(context.Context) error { t.Fatal("unverifiable voice session reached service"); return nil }}
	h := NewMusicHandler(legacy, stubPermResolver{}, nil, MusicAccessDependencies{Channels: &musicScopeChannel{channel: models.Channel{ID: "ch", ServerID: "srv", Type: models.ChannelTypeVoice}}, Voice: voice})
	w := httptest.NewRecorder()
	h.Play(w, musicControlRequest(http.MethodPost, `{"url":"https://youtu.be/0KbRhUtFwkc"}`))
	if w.Code != 403 || strings.Contains(w.Body.String(), "real-auth-session") {
		t.Fatalf("zero JoinedAt accepted/leaked: %d", w.Code)
	}
}
