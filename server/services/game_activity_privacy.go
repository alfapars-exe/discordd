package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

// GameActivityPrivacyPolicy is the authorization contract for a future
// game-activity publisher. A non-empty serverID asks whether viewerID may see
// targetID's activity in that shared server. An empty serverID asks for the
// target's global audience (accepted friends only). The target must be
// visibly online in either case. Self-view is always allowed.
//
// Callers must treat any error as a denial. This policy does not publish
// events, identify recipients, or make client-provided activity trustworthy.
// A server-scoped allow requires both users to be members even when they are
// accepted friends; channel-level access is outside this policy's scope.
type GameActivityPrivacyPolicy interface {
	CanView(context.Context, string, string, string) (bool, error)
	CanPublish(context.Context, string) (bool, error)
}

type gameActivityPreferenceReader interface {
	Get(context.Context, string) (*models.UserPreferences, error)
}

type gameActivityFriendshipReader interface {
	GetByPair(context.Context, string, string) (*models.Friendship, error)
	IsBlocked(context.Context, string, string) (bool, error)
}

type gameActivityServerReader interface {
	IsMember(context.Context, string, string) (bool, error)
	GetMemberCount(context.Context, string) (int, error)
}

type gameActivityMembershipAudienceReader interface {
	GetMemberGameActivityAudience(context.Context, string, string) (*bool, error)
}

type gameActivityBanReader interface {
	Exists(context.Context, string, string) (bool, error)
}

// gameActivityPresenceReader reports only currently visible online state.
// Implementations must return false for offline and invisible users.
type gameActivityPresenceReader interface {
	IsVisibleOnline(context.Context, string) (bool, error)
}

type gameActivityPrivacyPolicy struct {
	prefs    gameActivityPreferenceReader
	friends  gameActivityFriendshipReader
	servers  gameActivityServerReader
	presence gameActivityPresenceReader
	bans     gameActivityBanReader
}

// NewGameActivityPrivacyPolicy creates the server-side policy. All readers
// are required; a missing dependency fails closed when CanView is called.
func NewGameActivityPrivacyPolicy(
	prefs gameActivityPreferenceReader,
	friends gameActivityFriendshipReader,
	servers gameActivityServerReader,
	presence gameActivityPresenceReader,
	banReaders ...gameActivityBanReader,
) GameActivityPrivacyPolicy {
	policy := &gameActivityPrivacyPolicy{prefs: prefs, friends: friends, servers: servers, presence: presence}
	if len(banReaders) > 0 {
		policy.bans = banReaders[0]
	}
	return policy
}

type gameActivityAudience string

const (
	gameActivityAudienceAll         gameActivityAudience = "all"
	gameActivityAudienceSmall       gameActivityAudience = "small"
	gameActivityAudienceNone        gameActivityAudience = "none"
	gameActivityServerOverrideLimit                      = 1024
	gameActivityServerIDMaxLength                        = 256
)

type gameActivityPrivacySettings struct {
	Share             bool
	NewServerAudience gameActivityAudience
	ServerOverrides   map[string]bool
}

func (p *gameActivityPrivacyPolicy) CanView(ctx context.Context, viewerID, targetID, serverID string) (bool, error) {
	if viewerID == "" || targetID == "" {
		return false, errors.New("game activity privacy: viewer and target IDs are required")
	}
	if viewerID == targetID {
		return true, nil
	}
	if p.prefs == nil || p.friends == nil || p.servers == nil || p.presence == nil {
		return false, errors.New("game activity privacy: required reader is unavailable")
	}

	settings, err := p.readSettings(ctx, targetID)
	if err != nil {
		return false, err
	}
	if !settings.Share {
		return false, nil
	}

	visible, err := p.presence.IsVisibleOnline(ctx, targetID)
	if err != nil {
		return false, fmt.Errorf("game activity privacy: read target presence: %w", err)
	}
	if !visible {
		return false, nil
	}

	blocked, err := p.friends.IsBlocked(ctx, viewerID, targetID)
	if err != nil {
		return false, fmt.Errorf("game activity privacy: check blocks: %w", err)
	}
	if blocked {
		return false, nil
	}

	friendship, err := p.friends.GetByPair(ctx, viewerID, targetID)
	if err != nil && !errors.Is(err, pkg.ErrNotFound) {
		return false, fmt.Errorf("game activity privacy: read friendship: %w", err)
	}
	if serverID == "" {
		// Global sharing is an explicit opt-in. Accepted friends can see it
		// without sharing a server, subject to visibility and block checks above.
		return err == nil && friendship != nil && friendship.Status == models.FriendshipStatusAccepted, nil
	}

	viewerMember, err := p.servers.IsMember(ctx, serverID, viewerID)
	if err != nil {
		return false, fmt.Errorf("game activity privacy: check viewer server membership: %w", err)
	}
	targetMember, err := p.servers.IsMember(ctx, serverID, targetID)
	if err != nil {
		return false, fmt.Errorf("game activity privacy: check target server membership: %w", err)
	}
	if !viewerMember || !targetMember {
		return false, nil
	}
	if p.bans != nil {
		viewerBanned, err := p.bans.Exists(ctx, serverID, viewerID)
		if err != nil {
			return false, fmt.Errorf("game activity privacy: check viewer server ban: %w", err)
		}
		targetBanned, err := p.bans.Exists(ctx, serverID, targetID)
		if err != nil {
			return false, fmt.Errorf("game activity privacy: check target server ban: %w", err)
		}
		if viewerBanned || targetBanned {
			return false, nil
		}
	}
	if override, exists := settings.ServerOverrides[serverID]; exists {
		return override, nil
	}
	snapshotReader, ok := p.servers.(gameActivityMembershipAudienceReader)
	if !ok {
		return false, nil
	}
	snapshot, err := snapshotReader.GetMemberGameActivityAudience(ctx, serverID, targetID)
	if err != nil {
		return false, fmt.Errorf("game activity privacy: read membership audience snapshot: %w", err)
	}
	if snapshot == nil || !*snapshot {
		return false, nil
	}
	// Accepted friends remain eligible for global-context sharing, but a
	// server-scoped opt-out (explicit or join-time snapshot) is authoritative.
	if err == nil && friendship != nil && friendship.Status == models.FriendshipStatusAccepted {
		return true, nil
	}
	return true, nil
}

func gameActivityMembershipAllowed(ctx context.Context, prefs gameActivityPreferenceReader, userID string, memberCountAfter int) (bool, error) {
	audience, err := gameActivityMembershipAudience(ctx, prefs, userID)
	if err != nil {
		return false, err
	}
	switch audience {
	case gameActivityAudienceAll:
		return true, nil
	case gameActivityAudienceSmall:
		return memberCountAfter >= 0 && memberCountAfter <= smallProfileAudienceServerMax, nil
	case gameActivityAudienceNone:
		return false, nil
	default:
		return false, errors.New("game activity privacy: invalid new-server audience")
	}
}

func gameActivityMembershipAudience(ctx context.Context, prefs gameActivityPreferenceReader, userID string) (gameActivityAudience, error) {
	policy := &gameActivityPrivacyPolicy{prefs: prefs}
	settings, err := policy.readSettings(ctx, userID)
	if err != nil {
		return gameActivityAudienceNone, err
	}
	return settings.NewServerAudience, nil
}

// CanPublish reports whether the target explicitly opted into game activity
// and is currently visibly online. Unlike CanView, it never applies the
// self-view shortcut; publishers must not treat self-visibility as consent.
func (p *gameActivityPrivacyPolicy) CanPublish(ctx context.Context, targetID string) (bool, error) {
	if targetID == "" {
		return false, errors.New("game activity privacy: target ID is required")
	}
	if p.prefs == nil || p.presence == nil {
		return false, errors.New("game activity privacy: required reader is unavailable")
	}
	settings, err := p.readSettings(ctx, targetID)
	if err != nil {
		return false, err
	}
	if !settings.Share {
		return false, nil
	}
	visible, err := p.presence.IsVisibleOnline(ctx, targetID)
	if err != nil {
		return false, fmt.Errorf("game activity privacy: read target presence: %w", err)
	}
	return visible, nil
}

func (p *gameActivityPrivacyPolicy) readSettings(ctx context.Context, userID string) (gameActivityPrivacySettings, error) {
	settings := gameActivityPrivacySettings{
		NewServerAudience: gameActivityAudienceNone,
		ServerOverrides:   map[string]bool{},
	}
	if p.prefs == nil {
		return settings, errors.New("game activity privacy: preference reader is unavailable")
	}
	prefs, err := p.prefs.Get(ctx, userID)
	if err != nil {
		return settings, fmt.Errorf("game activity privacy: read preferences: %w", err)
	}
	if prefs == nil || len(prefs.Data) == 0 {
		return settings, nil
	}
	var root struct {
		Privacy *struct {
			Share             *bool                 `json:"shareGameActivity"`
			NewServerAudience *gameActivityAudience `json:"gameActivityNewServerAudience"`
			ServerOverrides   map[string]bool       `json:"gameActivityServerOverrides"`
		} `json:"privacy"`
	}
	if err := json.Unmarshal(prefs.Data, &root); err != nil {
		return settings, fmt.Errorf("game activity privacy: decode preferences: %w", err)
	}
	if root.Privacy == nil {
		return settings, nil
	}
	if root.Privacy.Share != nil {
		settings.Share = *root.Privacy.Share
	}
	if root.Privacy.NewServerAudience != nil {
		switch *root.Privacy.NewServerAudience {
		case gameActivityAudienceAll, gameActivityAudienceSmall, gameActivityAudienceNone:
			settings.NewServerAudience = *root.Privacy.NewServerAudience
		default:
			return settings, errors.New("game activity privacy: invalid new-server audience")
		}
	}
	if len(root.Privacy.ServerOverrides) > gameActivityServerOverrideLimit {
		return settings, errors.New("game activity privacy: server override limit exceeded")
	}
	for serverID := range root.Privacy.ServerOverrides {
		if serverID == "" || len(serverID) > gameActivityServerIDMaxLength || serverID == "__proto__" || serverID == "constructor" || serverID == "prototype" {
			return settings, errors.New("game activity privacy: invalid server override key")
		}
	}
	if root.Privacy.ServerOverrides != nil {
		settings.ServerOverrides = root.Privacy.ServerOverrides
	}
	return settings, nil
}
