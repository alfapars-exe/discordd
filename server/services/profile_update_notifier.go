package services

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

type profileFriendLister interface {
	ListFriends(context.Context, string) ([]models.FriendshipWithUser, error)
}

// ProfileUpdateNotifier writes the real notification event controlled by the
// profile owner's shareProfileUpdates preference.
type ProfileUpdateNotifier interface {
	NotifyProfileUpdated(context.Context, string) error
}

type profileUpdateNotifier struct {
	prefs         profilePreferenceReader
	friends       profileFriendLister
	notifications repository.NotificationRepository
	hub           ws.Broadcaster
}

func NewProfileUpdateNotifier(prefs profilePreferenceReader, friends profileFriendLister, notifications repository.NotificationRepository, hub ws.Broadcaster) ProfileUpdateNotifier {
	return &profileUpdateNotifier{prefs: prefs, friends: friends, notifications: notifications, hub: hub}
}

func (n *profileUpdateNotifier) NotifyProfileUpdated(ctx context.Context, actorID string) error {
	prefs, err := n.prefs.Get(ctx, actorID)
	if err != nil {
		return err
	}
	if prefs == nil || !validPreferenceData(prefs.Data) {
		return errors.New("profile update notifier: invalid actor preferences")
	}
	share := true
	var data struct {
		Privacy struct {
			ShareProfileUpdates *bool `json:"shareProfileUpdates"`
		} `json:"privacy"`
	}
	if len(prefs.Data) > 0 {
		if err := json.Unmarshal(prefs.Data, &data); err != nil {
			return err
		}
		if data.Privacy.ShareProfileUpdates != nil {
			share = *data.Privacy.ShareProfileUpdates
		}
	}
	if !share {
		return nil
	}

	friends, err := n.friends.ListFriends(ctx, actorID)
	if err != nil {
		return err
	}
	payload := json.RawMessage(`{"action":"profile_update"}`)
	var firstErr error
	for _, friend := range friends {
		recipientPrefs, prefErr := n.prefs.Get(ctx, friend.UserID)
		if prefErr != nil {
			firstErr = errors.Join(firstErr, prefErr)
			continue
		}
		if recipientPrefs == nil || !validPreferenceData(recipientPrefs.Data) {
			firstErr = errors.Join(firstErr, errors.New("profile update notifier: invalid recipient preferences"))
			continue
		}
		enabled := true
		var recipientData struct {
			Notifications struct {
				ProfileUpdates *bool `json:"profileUpdateNotifications"`
			} `json:"notifications"`
		}
		if len(recipientPrefs.Data) > 0 {
			if err := json.Unmarshal(recipientPrefs.Data, &recipientData); err != nil {
				firstErr = errors.Join(firstErr, err)
				continue
			}
			if recipientData.Notifications.ProfileUpdates != nil {
				enabled = *recipientData.Notifications.ProfileUpdates
			}
		}
		if !enabled {
			continue
		}
		actor := actorID
		notification := &models.Notification{
			UserID:  friend.UserID,
			Kind:    models.NotificationKindSystem,
			ActorID: &actor,
			Payload: payload,
		}
		if err := n.notifications.Create(ctx, notification); err != nil {
			firstErr = errors.Join(firstErr, err)
			continue
		}
		broadcastNotificationCreate(n.hub, notification)
	}
	return firstErr
}
