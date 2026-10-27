package services

import (
	"context"
	"encoding/json"
	"errors"
	"sort"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
)

const smallProfileAudienceServerMax = 200

type profilePreferenceReader interface {
	Get(context.Context, string) (*models.UserPreferences, error)
}

type profilePreferenceBatchReader interface {
	GetManyStrict(context.Context, []string) (map[string]*models.UserPreferences, error)
}

type profileFriendshipReader interface {
	GetByPair(context.Context, string, string) (*models.Friendship, error)
	ListFriends(context.Context, string) ([]models.FriendshipWithUser, error)
	IsBlocked(context.Context, string, string) (bool, error)
}

type profileServerReader interface {
	GetUserServers(context.Context, string) ([]models.ServerListItem, error)
	GetMemberCount(context.Context, string) (int, error)
	IsMember(context.Context, string, string) (bool, error)
	ListMemberIDs(context.Context, string) ([]string, error)
}

// ProfileAudiencePolicy enforces the target user's account-scoped profile
// audience. It is deliberately server-side; hiding controls in the client is
// not an authorization boundary.
type ProfileAudiencePolicy interface {
	CanView(context.Context, string, string) (bool, error)
}

// ProfileMemberAudiencePolicy extends public-profile decisions with efficient
// server-scoped checks for member roster APIs.
type ProfileMemberAudiencePolicy interface {
	ProfileAudiencePolicy
	CanViewInServer(context.Context, string, string, string) (bool, error)
	CanViewInServerMany(context.Context, string, []string, string) (map[string]bool, error)
}

// ProfileAudienceInvalidator enumerates only users who can currently view the
// target (or could view it under one of the supplied old/new audience modes).
type ProfileAudienceInvalidator interface {
	ListProfileAudienceViewers(context.Context, string, ...string) ([]string, error)
}

type ProfileAudienceServicePolicy interface {
	ProfileMemberAudiencePolicy
	ProfileAudienceInvalidator
}

type profileAudiencePolicy struct {
	prefs   profilePreferenceReader
	friends profileFriendshipReader
	servers profileServerReader
}

func NewProfileAudiencePolicy(prefs profilePreferenceReader, friends profileFriendshipReader, servers profileServerReader) ProfileAudienceServicePolicy {
	return &profileAudiencePolicy{prefs: prefs, friends: friends, servers: servers}
}

func (p *profileAudiencePolicy) CanView(ctx context.Context, viewerID, targetID string) (bool, error) {
	if viewerID == "" || targetID == "" {
		return false, errors.New("profile audience: viewer and target IDs are required")
	}
	if viewerID == targetID {
		return true, nil
	}
	if p.prefs == nil || p.friends == nil || p.servers == nil {
		return false, errors.New("profile audience: required reader is unavailable")
	}
	blocked, err := p.friends.IsBlocked(ctx, viewerID, targetID)
	if err != nil {
		return false, err
	}
	if blocked {
		return false, nil
	}

	audience := "all_servers"
	prefs, err := p.prefs.Get(ctx, targetID)
	if err != nil {
		return false, err
	}
	if prefs == nil || !validPreferenceData(prefs.Data) {
		return false, errors.New("profile audience: invalid target preferences")
	}
	audience, err = profileAudienceFromPreferences(prefs)
	if err != nil {
		return false, err
	}

	friendship, err := p.friends.GetByPair(ctx, viewerID, targetID)
	if err == nil && friendship != nil && friendship.Status == models.FriendshipStatusAccepted {
		return true, nil
	}
	if err != nil && !errors.Is(err, pkg.ErrNotFound) {
		return false, err
	}
	if audience == "friends_only" {
		return false, nil
	}

	viewerServers, err := p.servers.GetUserServers(ctx, viewerID)
	if err != nil {
		return false, err
	}
	targetServers, err := p.servers.GetUserServers(ctx, targetID)
	if err != nil {
		return false, err
	}
	targetSet := make(map[string]struct{}, len(targetServers))
	for _, server := range targetServers {
		targetSet[server.ID] = struct{}{}
	}
	for _, server := range viewerServers {
		if _, shared := targetSet[server.ID]; !shared {
			continue
		}
		if audience == "all_servers" {
			return true, nil
		}
		if audience == "small_servers" {
			count, err := p.servers.GetMemberCount(ctx, server.ID)
			if err != nil {
				return false, err
			}
			if count <= smallProfileAudienceServerMax {
				return true, nil
			}
		}
	}
	return false, nil
}

// ListProfileAudienceViewers builds a bounded, server-scoped invalidation
// audience. A signal is limited to users visible under at least one supplied
// audience mode, and both-direction blocks always remove the recipient.
func (p *profileAudiencePolicy) ListProfileAudienceViewers(ctx context.Context, targetID string, modes ...string) ([]string, error) {
	if targetID == "" || p.prefs == nil || p.friends == nil || p.servers == nil {
		return nil, errors.New("profile audience: required invalidation inputs are unavailable")
	}
	if len(modes) == 0 {
		prefs, err := p.prefs.Get(ctx, targetID)
		if err != nil {
			return nil, err
		}
		mode, err := profileAudienceFromPreferences(prefs)
		if err != nil {
			return nil, err
		}
		modes = []string{mode}
	}
	allowAll, allowSmall, allowFriends := false, false, false
	for _, mode := range modes {
		switch mode {
		case "all_servers":
			allowAll, allowFriends = true, true
		case "small_servers":
			allowSmall, allowFriends = true, true
		case "friends_only":
			allowFriends = true
		default:
			return nil, errors.New("profile audience: unknown invalidation audience")
		}
	}
	eligible := make(map[string]struct{})
	if allowFriends {
		friends, err := p.friends.ListFriends(ctx, targetID)
		if err != nil {
			return nil, err
		}
		for _, friend := range friends {
			if friend.Status == models.FriendshipStatusAccepted && friend.UserID != targetID {
				eligible[friend.UserID] = struct{}{}
			}
		}
	}
	if allowAll || allowSmall {
		servers, err := p.servers.GetUserServers(ctx, targetID)
		if err != nil {
			return nil, err
		}
		for _, server := range servers {
			include := allowAll
			if !include && allowSmall {
				count, err := p.servers.GetMemberCount(ctx, server.ID)
				if err != nil {
					return nil, err
				}
				include = count <= smallProfileAudienceServerMax
			}
			if !include {
				continue
			}
			members, err := p.servers.ListMemberIDs(ctx, server.ID)
			if err != nil {
				return nil, err
			}
			for _, id := range members {
				if id != targetID {
					eligible[id] = struct{}{}
				}
			}
		}
	}
	candidates := make([]string, 0, len(eligible))
	for id := range eligible {
		candidates = append(candidates, id)
	}
	sort.Strings(candidates)
	if len(candidates) == 0 {
		return candidates, nil
	}
	blocks, ok := p.friends.(repository.ProfileAudienceBlockReader)
	if !ok {
		return nil, errors.New("profile audience: bulk block reader is unavailable")
	}
	blocked, err := blocks.ListBlockedUserIDs(ctx, targetID, candidates)
	if err != nil {
		return nil, err
	}
	viewers := make([]string, 0, len(candidates))
	for _, id := range candidates {
		if !blocked[id] {
			viewers = append(viewers, id)
		}
	}
	sort.Strings(viewers)
	return viewers, nil
}

func profileAudienceFromPreferences(prefs *models.UserPreferences) (string, error) {
	if prefs == nil || !validPreferenceData(prefs.Data) {
		return "", errors.New("profile audience: invalid target preferences")
	}
	audience := "all_servers"
	var data struct {
		Privacy struct {
			ProfileAudience string `json:"profileAudience"`
		} `json:"privacy"`
	}
	if len(prefs.Data) > 0 {
		if err := json.Unmarshal(prefs.Data, &data); err != nil {
			return "", err
		}
		if data.Privacy.ProfileAudience != "" {
			audience = data.Privacy.ProfileAudience
		}
	}
	switch audience {
	case "all_servers", "small_servers", "friends_only":
		return audience, nil
	default:
		return "", errors.New("profile audience: unknown target audience")
	}
}

// CanViewInServer applies the same profile audience rules to a server-member
// response and first confirms that both accounts belong to the requested
// server. This prevents using a member endpoint as a shortcut to another
// shared server's profile.
func (p *profileAudiencePolicy) CanViewInServer(ctx context.Context, viewerID, targetID, serverID string) (bool, error) {
	if viewerID == "" || targetID == "" || serverID == "" {
		return false, errors.New("profile audience: viewer, target and server IDs are required")
	}
	if p.servers == nil {
		return false, errors.New("profile audience: server reader is unavailable")
	}
	viewerMember, err := p.servers.IsMember(ctx, serverID, viewerID)
	if err != nil {
		return false, err
	}
	targetMember, err := p.servers.IsMember(ctx, serverID, targetID)
	if err != nil {
		return false, err
	}
	if !viewerMember || !targetMember {
		return false, nil
	}
	return p.CanView(ctx, viewerID, targetID)
}

// CanViewInServerMany evaluates a member roster with bounded preference
// batches, one accepted-friend list, one membership roster and (when needed)
// a bounded shared-small-server query. The caller still receives the base
// member records; only profile fields are gated by these results.
func (p *profileAudiencePolicy) CanViewInServerMany(ctx context.Context, viewerID string, targetServerIDs []string, serverID string) (map[string]bool, error) {
	if viewerID == "" || serverID == "" {
		return nil, errors.New("profile audience: viewer and server IDs are required")
	}
	if p.prefs == nil || p.friends == nil || p.servers == nil {
		return nil, errors.New("profile audience: required reader is unavailable")
	}
	batchPrefs, ok := p.prefs.(profilePreferenceBatchReader)
	if !ok {
		return nil, errors.New("profile audience: batch preference reader is unavailable")
	}
	viewerMember, err := p.servers.IsMember(ctx, serverID, viewerID)
	if err != nil {
		return nil, err
	}
	if !viewerMember {
		return nil, nil
	}
	memberIDs, err := p.servers.ListMemberIDs(ctx, serverID)
	if err != nil {
		return nil, err
	}
	members := make(map[string]struct{}, len(memberIDs))
	for _, id := range memberIDs {
		members[id] = struct{}{}
	}
	targets := make([]string, 0, len(targetServerIDs))
	seen := make(map[string]struct{}, len(targetServerIDs))
	for _, id := range targetServerIDs {
		if id == "" {
			return nil, errors.New("profile audience: target ID is required")
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		if _, ok := members[id]; ok && id != viewerID {
			targets = append(targets, id)
		}
	}
	result := make(map[string]bool, len(targetServerIDs))
	if _, ok := members[viewerID]; !ok {
		return result, nil
	}
	if len(targets) == 0 {
		for _, id := range targetServerIDs {
			result[id] = id == viewerID && viewerMember
		}
		return result, nil
	}
	prefs, err := batchPrefs.GetManyStrict(ctx, targets)
	if err != nil {
		return nil, err
	}
	friends, err := p.friends.ListFriends(ctx, viewerID)
	if err != nil {
		return nil, err
	}
	blockReader, ok := p.friends.(repository.ProfileAudienceBlockReader)
	if !ok {
		return nil, errors.New("profile audience: bulk block reader is unavailable")
	}
	blockedIDs, err := blockReader.ListBlockedUserIDs(ctx, viewerID, targets)
	if err != nil {
		return nil, err
	}
	friendIDs := make(map[string]struct{}, len(friends))
	for _, friend := range friends {
		if friend.Status == models.FriendshipStatusAccepted {
			friendIDs[friend.UserID] = struct{}{}
		}
	}
	needsSmallServerCount := false
	for _, id := range targets {
		prefsForTarget, found := prefs[id]
		if !found || prefsForTarget == nil {
			return nil, errors.New("profile audience: batch preference result is incomplete")
		}
		audience, err := profileAudienceFromPreferences(prefsForTarget)
		if err != nil {
			return nil, err
		}
		if _, isFriend := friendIDs[id]; !isFriend && audience == "small_servers" {
			needsSmallServerCount = true
		}
	}
	smallSharedServers := map[string]bool{}
	if needsSmallServerCount {
		batchServers, ok := p.servers.(repository.ProfileAudienceSharedServerReader)
		if !ok {
			return nil, errors.New("profile audience: batch shared-server reader is unavailable")
		}
		smallSharedServers, err = batchServers.ListSmallSharedServerUserIDs(ctx, viewerID, targets, smallProfileAudienceServerMax)
		if err != nil {
			return nil, err
		}
	}
	for _, id := range targetServerIDs {
		if id == viewerID {
			result[id] = viewerMember
			continue
		}
		if _, isMember := members[id]; !isMember {
			result[id] = false
			continue
		}
		if blockedIDs[id] {
			result[id] = false
			continue
		}
		if _, isFriend := friendIDs[id]; isFriend {
			result[id] = true
			continue
		}
		audience, _ := profileAudienceFromPreferences(prefs[id])
		result[id] = audience == "all_servers" || (audience == "small_servers" && smallSharedServers[id])
	}
	return result, nil
}
