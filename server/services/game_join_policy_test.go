package services

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
	"testing"
	"time"
)

type joinPolicyPrefs struct {
	repository.PreferencesRepository
	data map[string]json.RawMessage
	fail bool
}

func (p *joinPolicyPrefs) Get(_ context.Context, id string) (*models.UserPreferences, error) {
	if p.fail {
		return nil, errors.New("db unavailable")
	}
	return &models.UserPreferences{Data: p.data[id]}, nil
}

type joinLifecycle struct {
	repository.AccountLifecycleRepository
	disabled string
}

func (p *joinLifecycle) Get(_ context.Context, id string) (*models.AccountLifecycle, error) {
	v := &models.AccountLifecycle{}
	if p.disabled == id {
		now := int64(1)
		v.DisabledAt = &now
	}
	return v, nil
}
func TestGameJoinPolicyFreshConsentRelationshipsAndVoiceScope(t *testing.T) {
	cases := []string{"allowed-friend", "allowed-voice", "default-off", "share-off", "blocked", "pending-friend", "viewer-ignore", "host-ignore", "community", "wrong-channel", "missing-member", "banned", "no-view", "no-connect", "disabled-viewer", "disabled-host", "bot", "preferences-error", "invisible"}
	for _, name := range cases {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			consent := `{"privacy":{"shareGameActivity":true,"allowFriendsToJoinGame":true,"allowVoiceParticipantsToJoinGame":true,"gameActivityServerOverrides":{"server":true}}}`
			prefs := &joinPolicyPrefs{data: map[string]json.RawMessage{"host": json.RawMessage(consent), "viewer": json.RawMessage(`{}`)}}
			friends := &testutil.MockFriendshipRepo{GetByPairFn: func(context.Context, string, string) (*models.Friendship, error) {
				status := models.FriendshipStatusAccepted
				if name == "pending-friend" {
					status = models.FriendshipStatusPending
				}
				return &models.Friendship{Status: status}, nil
			}, IsBlockedFn: func(context.Context, string, string) (bool, error) { return name == "blocked", nil }}
			servers := &testutil.MockServerRepo{IsMemberFn: func(context.Context, string, string) (bool, error) { return name != "missing-member", nil }, GetByIDFn: func(context.Context, string) (*models.Server, error) {
				return &models.Server{ID: "server", IsCommunity: name == "community"}, nil
			}}
			bans := &testutil.MockBanRepo{ExistsFn: func(context.Context, string, string) (bool, error) { return name == "banned", nil }}
			users := &testutil.MockUserRepo{GetByIDFn: func(_ context.Context, id string) (*models.User, error) {
				return &models.User{ID: id, IsBot: name == "bot"}, nil
			}}
			lifecycle := &joinLifecycle{}
			if name == "disabled-viewer" {
				lifecycle.disabled = "viewer"
			}
			if name == "disabled-host" {
				lifecycle.disabled = "host"
			}
			if name == "default-off" {
				prefs.data["host"] = json.RawMessage(`{"privacy":{"shareGameActivity":true}}`)
			}
			if name == "share-off" {
				prefs.data["host"] = json.RawMessage(`{"privacy":{"allowFriendsToJoinGame":true}}`)
			}
			if name == "viewer-ignore" {
				prefs.data["viewer"] = json.RawMessage(`{"privacy":{"ignoredUsers":{"host":true}}}`)
			}
			if name == "host-ignore" {
				prefs.data["host"] = json.RawMessage(`{"privacy":{"shareGameActivity":true,"allowFriendsToJoinGame":true,"ignoredUsers":{"viewer":true}}}`)
			}
			if name == "preferences-error" {
				prefs.fail = true
			}
			activity := NewGameActivityPrivacyPolicy(prefs, friends, servers, gameActivityPresenceStub{visible: name != "invisible"}, bans)
			channels := &testutil.MockChannelRepo{GetByIDFn: func(context.Context, string) (*models.Channel, error) {
				server := "server"
				if name == "wrong-channel" {
					server = "elsewhere"
				}
				return &models.Channel{ID: "channel", ServerID: server, Type: models.ChannelTypeVoice}, nil
			}}
			perms := &testutil.MockChannelPermResolver{ResolveChannelPermissionsFn: func(context.Context, string, string) (models.Permission, error) {
				v := models.PermViewChannel | models.PermConnectVoice
				if name == "no-view" {
					v = models.PermConnectVoice
				}
				if name == "no-connect" {
					v = models.PermViewChannel
				}
				return v, nil
			}}
			voice := &voiceService{states: map[string]*models.VoiceState{"viewer": {UserID: "viewer", ServerID: "server", ChannelID: "channel", JoinedAt: time.Now()}, "host": {UserID: "host", ServerID: "server", ChannelID: "channel", JoinedAt: time.Now()}}}
			p := NewGameJoinPolicy(activity, prefs, friends, users, lifecycle, servers, bans, channels, perms, voice)
			c := GameJoinContext{TargetUserID: "host", Context: "friend"}
			if name == "allowed-voice" || name == "community" || name == "wrong-channel" || name == "missing-member" || name == "banned" || name == "no-view" || name == "no-connect" {
				c.Context = "voice"
				c.ServerID = "server"
				c.ChannelID = "channel"
			}
			admit, e := p.Authorize(ctx, "viewer", c)
			want := name == "allowed-friend" || name == "allowed-voice"
			if want {
				if e != nil || admit == nil {
					t.Fatal("authorized policy rejected", e)
				}
				if e = admit(func() error { return nil }); e != nil {
					t.Fatal(e)
				}
			} else if e == nil || admit != nil {
				t.Fatal("denied policy admitted")
			}
		})
	}
}
func TestGameJoinVoiceAdmissionRejectsLeaveRejoinSameChannel(t *testing.T) {
	now := time.Now()
	v := &voiceService{states: map[string]*models.VoiceState{"a": {UserID: "a", ServerID: "s", ChannelID: "c", JoinedAt: now}, "b": {UserID: "b", ServerID: "s", ChannelID: "c", JoinedAt: now}}}
	admit, e := v.GameJoinVoiceAdmission("a", "b", "s", "c")
	if e != nil {
		t.Fatal(e)
	}
	v.mu.Lock()
	v.states["a"].ChannelGeneration++
	v.mu.Unlock()
	called := false
	if e = admit(func() error { called = true; return nil }); !errors.Is(e, pkg.ErrForbidden) || called {
		t.Fatal("voice incarnation changed but admission committed", e)
	}
}
