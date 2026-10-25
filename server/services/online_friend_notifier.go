package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

const (
	onlineFriendStateTTL        = 30 * time.Minute
	maxOnlineFriendTrackedUsers = 10_000
)

type onlineFriendUserReader interface {
	GetByID(context.Context, string) (*models.User, error)
}

type onlineFriendPreferenceReader interface {
	Get(context.Context, string) (*models.UserPreferences, error)
}

type onlineFriendRelationshipReader interface {
	ListFriends(context.Context, string) ([]models.FriendshipWithUser, error)
	IsBlocked(context.Context, string, string) (bool, error)
}

type onlineFriendPresenceReader interface {
	GetVisibleOnlineUserIDs() []string
}

type onlineFriendEpoch struct {
	mu       sync.Mutex
	refs     int
	lastUsed time.Time
	sentTo   map[string]struct{}
}

// OnlineFriendNotifier emits an inbox notification when an accepted friend
// becomes visibly online. The caller owns edge detection and must call
// ObserveOffline only for a real offline transition (not a transient socket
// disconnect that is still inside the presence grace period).
//
// The actor-side privacy.shareOnlineUpdates preference defaults to true for
// compatibility. Actor visibility is additionally limited to persisted online
// status and the Hub's visible-presence set.
type OnlineFriendNotifier interface {
	NotifyOnline(context.Context, string) error
	ObserveOffline(string)
}

type onlineFriendNotifier struct {
	users         onlineFriendUserReader
	prefs         onlineFriendPreferenceReader
	friends       onlineFriendRelationshipReader
	notifications repository.NotificationRepository
	guardedWriter repository.OnlineFriendNotificationRepository
	presence      onlineFriendPresenceReader
	hub           ws.Broadcaster

	mu     sync.Mutex
	epochs map[string]*onlineFriendEpoch
}

func NewOnlineFriendNotifier(
	users onlineFriendUserReader,
	prefs onlineFriendPreferenceReader,
	friends onlineFriendRelationshipReader,
	notifications repository.NotificationRepository,
	presence onlineFriendPresenceReader,
	hub ws.Broadcaster,
) OnlineFriendNotifier {
	guardedWriter, _ := notifications.(repository.OnlineFriendNotificationRepository)
	return &onlineFriendNotifier{
		users: users, prefs: prefs, friends: friends,
		notifications: notifications, guardedWriter: guardedWriter, presence: presence, hub: hub,
		epochs: make(map[string]*onlineFriendEpoch),
	}
}

func (n *onlineFriendNotifier) NotifyOnline(ctx context.Context, actorID string) error {
	if actorID == "" {
		return errors.New("online friend notifier: actor ID is required")
	}
	if n.guardedWriter == nil {
		return errors.New("online friend notifier: guarded notification repository is unavailable")
	}

	actor, err := n.users.GetByID(ctx, actorID)
	if err != nil {
		return fmt.Errorf("online friend notifier: load actor: %w", err)
	}
	if actor == nil || actor.ID != actorID || actor.Status == models.UserStatusOffline || !containsOnlineID(n.presence.GetVisibleOnlineUserIDs(), actorID) {
		return nil
	}

	epoch := n.acquireEpoch(actorID)
	defer n.releaseEpoch(actorID, epoch)
	epoch.mu.Lock()
	defer epoch.mu.Unlock()

	actorPrefs, err := n.prefs.Get(ctx, actorID)
	if err != nil {
		return fmt.Errorf("online friend notifier: load actor preferences: %w", err)
	}
	if actorPrefs == nil || !validPreferenceData(actorPrefs.Data) {
		return errors.New("online friend notifier: invalid actor preferences")
	}
	shareOnline, err := onlineActivitySharingEnabled(actorPrefs)
	if err != nil {
		return fmt.Errorf("online friend notifier: read actor privacy preferences: %w", err)
	}
	if !shareOnline {
		return nil
	}

	friends, err := n.friends.ListFriends(ctx, actorID)
	if err != nil {
		return fmt.Errorf("online friend notifier: list friends: %w", err)
	}

	var firstErr error
	for _, friend := range friends {
		recipientID := friend.UserID
		if recipientID == "" || recipientID == actorID {
			continue
		}
		if _, sent := epoch.sentTo[recipientID]; sent {
			continue
		}

		blocked, blockErr := n.friends.IsBlocked(ctx, actorID, recipientID)
		if blockErr != nil {
			firstErr = errors.Join(firstErr, fmt.Errorf("online friend notifier: check block for %s: %w", recipientID, blockErr))
			continue
		}
		if blocked {
			continue
		}

		recipientPrefs, prefErr := n.prefs.Get(ctx, recipientID)
		if prefErr != nil {
			firstErr = errors.Join(firstErr, fmt.Errorf("online friend notifier: load preferences for %s: %w", recipientID, prefErr))
			continue
		}
		enabled, prefErr := onlineFriendNotificationsEnabled(recipientPrefs)
		if prefErr != nil {
			firstErr = errors.Join(firstErr, fmt.Errorf("online friend notifier: read preferences for %s: %w", recipientID, prefErr))
			continue
		}
		if !enabled {
			// This is still a completed decision for this epoch. A later
			// duplicate callback must not deliver after a preference change.
			epoch.sentTo[recipientID] = struct{}{}
			continue
		}
		stillVisible, shareOnline, visibilityErr := n.actorStillVisible(ctx, actorID)
		if visibilityErr != nil {
			firstErr = errors.Join(firstErr, visibilityErr)
			continue
		}
		if !stillVisible || !shareOnline {
			return firstErr
		}

		actorCopy := actorID
		actorName := actor.Username
		if actor.DisplayName != nil && *actor.DisplayName != "" {
			actorName = *actor.DisplayName
		}
		payload, _ := json.Marshal(map[string]string{
			"action": "friend_online",
			"title":  "Friend is online",
			"body":   actorName + " is now online.",
		})
		notification := &models.Notification{
			UserID:  recipientID,
			Kind:    models.NotificationKindSystem,
			ActorID: &actorCopy,
			Payload: payload,
		}
		committed, err := n.guardedWriter.CreateIfOnlineFriendEligible(ctx, actorID, recipientID, notification)
		if err != nil {
			firstErr = errors.Join(firstErr, fmt.Errorf("online friend notifier: create notification for %s: %w", recipientID, err))
			continue
		}
		if committed == nil {
			// The transaction rechecked the live relationship and both users'
			// preferences. A stale candidate is not broadcast or marked sent.
			continue
		}
		epoch.sentTo[recipientID] = struct{}{}
		broadcastNotificationCreate(n.hub, committed)
	}
	return firstErr
}

func (n *onlineFriendNotifier) actorStillVisible(ctx context.Context, actorID string) (bool, bool, error) {
	actor, err := n.users.GetByID(ctx, actorID)
	if err != nil {
		return false, false, fmt.Errorf("online friend notifier: recheck actor: %w", err)
	}
	if actor == nil || actor.ID != actorID || actor.Status == models.UserStatusOffline || !containsOnlineID(n.presence.GetVisibleOnlineUserIDs(), actorID) {
		return false, false, nil
	}
	prefs, err := n.prefs.Get(ctx, actorID)
	if err != nil {
		return false, false, fmt.Errorf("online friend notifier: recheck actor preferences: %w", err)
	}
	if prefs == nil || !validPreferenceData(prefs.Data) {
		return false, false, errors.New("online friend notifier: invalid actor preferences during write recheck")
	}
	sharing, err := onlineActivitySharingEnabled(prefs)
	if err != nil {
		return false, false, fmt.Errorf("online friend notifier: re-read actor privacy preferences: %w", err)
	}
	return true, sharing, nil
}

func (n *onlineFriendNotifier) ObserveOffline(actorID string) {
	if actorID == "" {
		return
	}
	epoch := n.acquireEpoch(actorID)
	epoch.mu.Lock()
	epoch.sentTo = make(map[string]struct{})
	epoch.mu.Unlock()
	n.releaseEpoch(actorID, epoch)
}

func (n *onlineFriendNotifier) acquireEpoch(actorID string) *onlineFriendEpoch {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.pruneEpochsLocked(time.Now())
	epoch := n.epochs[actorID]
	if epoch == nil {
		epoch = &onlineFriendEpoch{sentTo: make(map[string]struct{})}
		n.epochs[actorID] = epoch
	}
	epoch.refs++
	epoch.lastUsed = time.Now()
	return epoch
}

func (n *onlineFriendNotifier) releaseEpoch(actorID string, epoch *onlineFriendEpoch) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.epochs[actorID] != epoch {
		return
	}
	epoch.refs--
	epoch.lastUsed = time.Now()
}

func (n *onlineFriendNotifier) pruneEpochsLocked(now time.Time) {
	for actorID, epoch := range n.epochs {
		if epoch.refs == 0 && now.Sub(epoch.lastUsed) >= onlineFriendStateTTL {
			delete(n.epochs, actorID)
		}
	}
	if len(n.epochs) < maxOnlineFriendTrackedUsers {
		return
	}
	// Under sustained churn with no offline callbacks, retain only the most
	// recently used idle gates; active gates are never evicted.
	var oldestID string
	var oldest time.Time
	for actorID, epoch := range n.epochs {
		if epoch.refs == 0 && (oldestID == "" || epoch.lastUsed.Before(oldest)) {
			oldestID, oldest = actorID, epoch.lastUsed
		}
	}
	if oldestID != "" {
		delete(n.epochs, oldestID)
	}
}

func validPreferenceData(data json.RawMessage) bool {
	if len(data) == 0 {
		return true
	}
	var value map[string]json.RawMessage
	return json.Unmarshal(data, &value) == nil && value != nil
}

func onlineFriendNotificationsEnabled(prefs *models.UserPreferences) (bool, error) {
	if prefs == nil || len(prefs.Data) == 0 {
		return false, nil
	}
	var data struct {
		Notifications struct {
			OnlineFriendNotifications *bool `json:"onlineFriendNotifications"`
		} `json:"notifications"`
	}
	if err := json.Unmarshal(prefs.Data, &data); err != nil {
		return false, err
	}
	return data.Notifications.OnlineFriendNotifications != nil && *data.Notifications.OnlineFriendNotifications, nil
}

func onlineActivitySharingEnabled(prefs *models.UserPreferences) (bool, error) {
	if prefs == nil || len(prefs.Data) == 0 {
		return true, nil
	}
	var data struct {
		Privacy struct {
			ShareOnlineUpdates *bool `json:"shareOnlineUpdates"`
		} `json:"privacy"`
	}
	if err := json.Unmarshal(prefs.Data, &data); err != nil {
		return false, err
	}
	return data.Privacy.ShareOnlineUpdates == nil || *data.Privacy.ShareOnlineUpdates, nil
}

func containsOnlineID(userIDs []string, want string) bool {
	for _, userID := range userIDs {
		if userID == want {
			return true
		}
	}
	return false
}
