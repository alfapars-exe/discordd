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

// OnlineFriendNotificationError carries one bounded summary, never one
// repeated context error per remaining friend.
type OnlineFriendNotificationError struct {
	Processed, Delivered, Skipped, Failed int
	Duration                              time.Duration
	Err                                   error
}

func (e *OnlineFriendNotificationError) Error() string {
	return fmt.Sprintf("online friend notifications failed (processed=%d delivered=%d skipped=%d failed=%d): %v", e.Processed, e.Delivered, e.Skipped, e.Failed, e.Err)
}
func (e *OnlineFriendNotificationError) Unwrap() error { return e.Err }

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

	mu        sync.Mutex
	epochs    map[string]*onlineFriendEpoch
	lifecycle context.Context
	stop      context.CancelFunc
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
	lifecycle, stop := context.WithCancel(context.Background())
	return &onlineFriendNotifier{
		users: users, prefs: prefs, friends: friends,
		notifications: notifications, guardedWriter: guardedWriter, presence: presence, hub: hub,
		epochs: make(map[string]*onlineFriendEpoch), lifecycle: lifecycle, stop: stop,
	}
}

func (n *onlineFriendNotifier) Stop() { n.stop() }

// Called only after the presence status was committed and broadcast. Keep this
// synchronous in the existing per-user dispatcher to preserve transition order.
func (n *onlineFriendNotifier) NotifyOnlinePresence(actorID string) error {
	ctx, cancel := context.WithTimeout(n.lifecycle, 5*time.Second)
	defer cancel()
	return n.NotifyOnline(ctx, actorID)
}

func (n *onlineFriendNotifier) NotifyOnline(ctx context.Context, actorID string) (resultErr error) {
	start := time.Now()
	processed, delivered, skipped, failed := 0, 0, 0, 0
	defer func() {
		if resultErr != nil {
			resultErr = &OnlineFriendNotificationError{Processed: processed, Delivered: delivered, Skipped: skipped, Failed: failed, Duration: time.Since(start), Err: resultErr}
		}
	}()
	if err := ctx.Err(); err != nil {
		return err
	}
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

	var friends []models.FriendshipWithUser
	bulk := make(map[string]repository.OnlineFriendCandidate)
	bulkReader, hasBulk := n.notifications.(interface {
		ListOnlineFriendCandidates(context.Context, string) ([]repository.OnlineFriendCandidate, error)
	})
	if hasBulk {
		candidates, loadErr := bulkReader.ListOnlineFriendCandidates(ctx, actorID)
		if loadErr != nil {
			return loadErr
		}
		for _, c := range candidates {
			bulk[c.UserID] = c
			friends = append(friends, models.FriendshipWithUser{UserID: c.UserID})
		}
	} else {
		friends, err = n.friends.ListFriends(ctx, actorID)
		if err != nil {
			return fmt.Errorf("online friend notifier: list friends: %w", err)
		}
	}

	var firstErr error
	for _, friend := range friends {
		if err := ctx.Err(); err != nil {
			return errors.Join(firstErr, err)
		}
		processed++
		recipientID := friend.UserID
		if recipientID == "" || recipientID == actorID {
			continue
		}
		if _, sent := epoch.sentTo[recipientID]; sent {
			continue
		}

		var blocked bool
		var recipientPrefs *models.UserPreferences
		var prefErr error
		if hasBulk {
			candidate := bulk[recipientID]
			blocked = candidate.Blocked
			recipientPrefs = candidate.Preferences
		} else {
			var blockErr error
			blocked, blockErr = n.friends.IsBlocked(ctx, actorID, recipientID)
			if blockErr != nil {
				failed++
				if firstErr == nil {
					firstErr = fmt.Errorf("online friend notifier: check block: %w", blockErr)
				}
				continue
			}
			if err := ctx.Err(); err != nil {
				return errors.Join(firstErr, err)
			}
			recipientPrefs, prefErr = n.prefs.Get(ctx, recipientID)
		}
		if blocked {
			skipped++
			continue
		}
		if prefErr != nil {
			failed++
			if firstErr == nil {
				firstErr = fmt.Errorf("online friend notifier: load recipient preferences: %w", prefErr)
			}
			continue
		}

		enabled, prefErr := onlineFriendNotificationsEnabled(recipientPrefs)
		if prefErr != nil {
			failed++
			if firstErr == nil {
				firstErr = fmt.Errorf("online friend notifier: recipient preferences: %w", prefErr)
			}
			continue
		}
		if !enabled {
			skipped++
			// This is still a completed decision for this epoch. A later
			// duplicate callback must not deliver after a preference change.
			epoch.sentTo[recipientID] = struct{}{}
			continue
		}
		if hasBulk {
			// The guarded write below owns persisted privacy checks; the Hub remains
			// authoritative for in-memory visibility. Avoid redundant per-recipient reads.
			if !containsOnlineID(n.presence.GetVisibleOnlineUserIDs(), actorID) {
				return firstErr
			}
		} else {
			stillVisible, shareOnline, visibilityErr := n.actorStillVisible(ctx, actorID)
			if visibilityErr != nil {
				failed++
				if firstErr == nil {
					firstErr = visibilityErr
				}
				continue
			}
			if !stillVisible || !shareOnline {
				return firstErr
			}
		}
		if err := ctx.Err(); err != nil {
			return errors.Join(firstErr, err)
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
			failed++
			if firstErr == nil {
				firstErr = fmt.Errorf("online friend notifier: create notification: %w", err)
			}
			continue
		}
		if committed == nil {
			// The transaction rechecked the live relationship and both users'
			// preferences. A stale candidate is not broadcast or marked sent.
			continue
		}
		epoch.sentTo[recipientID] = struct{}{}
		delivered++
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
