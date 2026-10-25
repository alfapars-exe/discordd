package services

import (
	"context"
	"encoding/json"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
)

type gameJoinVoiceAdmission interface {
	GameJoinVoiceAdmission(string, string, string, string) (func(func() error) error, error)
}
type gameJoinPolicy struct {
	activity    GameActivityPrivacyPolicy
	prefs       repository.PreferencesRepository
	friends     repository.FriendshipRepository
	users       repository.UserRepository
	lifecycle   repository.AccountLifecycleRepository
	servers     repository.ServerRepository
	bans        repository.BanRepository
	channels    ChannelGetter
	permissions ChannelPermResolver
	voice       gameJoinVoiceAdmission
}

func NewGameJoinPolicy(activity GameActivityPrivacyPolicy, prefs repository.PreferencesRepository, friends repository.FriendshipRepository, users repository.UserRepository, lifecycle repository.AccountLifecycleRepository, servers repository.ServerRepository, bans repository.BanRepository, channels ChannelGetter, permissions ChannelPermResolver, voice VoiceService) GameJoinPolicy {
	v, _ := voice.(gameJoinVoiceAdmission)
	return &gameJoinPolicy{activity, prefs, friends, users, lifecycle, servers, bans, channels, permissions, v}
}
func (p *gameJoinPolicy) Authorize(ctx context.Context, viewer string, c GameJoinContext) (func(func() error) error, error) {
	deny := func() (func(func() error) error, error) { return nil, pkg.ErrForbidden }
	if !c.Valid() || viewer == "" || viewer == c.TargetUserID || p.activity == nil || p.prefs == nil || p.friends == nil || p.users == nil || p.lifecycle == nil {
		return deny()
	}
	for _, id := range []string{viewer, c.TargetUserID} {
		u, e := p.users.GetByID(ctx, id)
		if e != nil {
			return nil, e
		}
		if u == nil || u.IsBot || u.IsPlatformBanned {
			return deny()
		}
		state, e := p.lifecycle.Get(ctx, id)
		if e != nil {
			return nil, e
		}
		if state == nil || state.DisabledAt != nil {
			return deny()
		}
	}
	allowed, e := p.activity.CanView(ctx, viewer, c.TargetUserID, c.ServerID)
	if e != nil {
		return nil, e
	}
	if !allowed {
		return deny()
	}
	var targetJoin bool
	for _, id := range []string{viewer, c.TargetUserID} {
		pref, e := p.prefs.Get(ctx, id)
		if e != nil {
			return nil, e
		}
		var root struct {
			Privacy struct {
				Share   bool            `json:"shareGameActivity"`
				Friends bool            `json:"allowFriendsToJoinGame"`
				Voice   bool            `json:"allowVoiceParticipantsToJoinGame"`
				Ignored map[string]bool `json:"ignoredUsers"`
			} `json:"privacy"`
		}
		if pref != nil && len(pref.Data) > 0 {
			if e = json.Unmarshal(pref.Data, &root); e != nil {
				return nil, e
			}
		}
		other := viewer
		if id == viewer {
			other = c.TargetUserID
		}
		if root.Privacy.Ignored[other] {
			return deny()
		}
		if id == c.TargetUserID {
			if !root.Privacy.Share {
				return deny()
			}
			targetJoin = (c.Context == "friend" && root.Privacy.Friends) || (c.Context == "voice" && root.Privacy.Voice)
		}
	}
	if !targetJoin {
		return deny()
	}
	if c.Context == "friend" {
		f, e := p.friends.GetByPair(ctx, viewer, c.TargetUserID)
		if e != nil {
			return nil, e
		}
		if f == nil || f.Status != models.FriendshipStatusAccepted {
			return deny()
		}
		return func(commit func() error) error {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return commit()
		}, nil
	}
	if p.servers == nil || p.channels == nil || p.permissions == nil || p.voice == nil || p.bans == nil {
		return deny()
	}
	admission, e := p.voice.GameJoinVoiceAdmission(viewer, c.TargetUserID, c.ServerID, c.ChannelID)
	if e != nil {
		return nil, e
	}
	server, e := p.servers.GetByID(ctx, c.ServerID)
	if e != nil {
		return nil, e
	}
	if server == nil || server.IsCommunity {
		return deny()
	}
	channel, e := p.channels.GetByID(ctx, c.ChannelID)
	if e != nil {
		return nil, e
	}
	if channel == nil || channel.ServerID != c.ServerID || channel.Type != models.ChannelTypeVoice {
		return deny()
	}
	for _, id := range []string{viewer, c.TargetUserID} {
		member, e := p.servers.IsMember(ctx, c.ServerID, id)
		if e != nil {
			return nil, e
		}
		if !member {
			return deny()
		}
		banned, e := p.bans.Exists(ctx, c.ServerID, id)
		if e != nil {
			return nil, e
		}
		if banned {
			return deny()
		}
	}
	permissions, e := resolveFreshVoiceFanoutPermissions(ctx, p.permissions, c.ChannelID, []string{viewer, c.TargetUserID})
	if e != nil {
		return nil, e
	}
	for _, id := range []string{viewer, c.TargetUserID} {
		if !permissions[id].Has(models.PermViewChannel) || !permissions[id].Has(models.PermConnectVoice) {
			return deny()
		}
	}
	return func(commit func() error) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return admission(commit)
	}, nil
}

// Capture both incarnations before slow DB work, then atomically recheck them
// at the commit boundary. Leaving/rejoining the same channel is not equivalent.
func (s *voiceService) GameJoinVoiceAdmission(viewer, target, server, channel string) (func(func() error) error, error) {
	s.mu.RLock()
	a, b := s.states[viewer], s.states[target]
	if a == nil || b == nil || a.ServerID != server || b.ServerID != server || a.ChannelID != channel || b.ChannelID != channel {
		s.mu.RUnlock()
		return nil, pkg.ErrForbidden
	}
	ac, bc := *a, *b
	s.mu.RUnlock()
	return func(commit func() error) error {
		s.mu.RLock()
		defer s.mu.RUnlock()
		a, b := s.states[viewer], s.states[target]
		if a == nil || b == nil || a.ServerID != server || b.ServerID != server || a.ChannelID != channel || b.ChannelID != channel || a.JoinedAt != ac.JoinedAt || b.JoinedAt != bc.JoinedAt || a.ChannelGeneration != ac.ChannelGeneration || b.ChannelGeneration != bc.ChannelGeneration {
			return pkg.ErrForbidden
		}
		return commit()
	}, nil
}
