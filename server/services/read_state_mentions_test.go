package services

import (
	"context"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
)

type mentionReadRepo struct{ repository.ReadStateRepository }

func (mentionReadRepo) GetUnreadCounts(_ context.Context, _, _ string) ([]models.UnreadInfo, error) {
	secret := "must-not-leak"
	return []models.UnreadInfo{
		{ChannelID: "allowed", UnreadCount: 9, MentionCount: 3, OldestUnreadMessageID: &secret},
		{ChannelID: "voice-view-read", UnreadCount: 5, MentionCount: 1, OldestUnreadMessageID: &secret},
		{ChannelID: "denied", UnreadCount: 8, MentionCount: 2, OldestUnreadMessageID: &secret},
		{ChannelID: "voice-no-read", UnreadCount: 6, MentionCount: 1, OldestUnreadMessageID: &secret},
		{ChannelID: "departed", UnreadCount: 7, MentionCount: 1, OldestUnreadMessageID: &secret},
	}, nil
}
func TestReadStateMentionsApplyLiveReadPermissions(t *testing.T) {
	resolver := &testutil.MockChannelPermResolver{}
	resolver.ResolveChannelPermissionsFn = func(_ context.Context, user, channel string) (models.Permission, error) {
		if user != "owner" {
			t.Fatalf("unexpected user %s", user)
		}
		if channel == "departed" {
			return 0, pkg.ErrNotFound
		}
		if channel == "denied" || channel == "voice-no-read" {
			return models.PermViewChannel, nil
		}
		if channel == "voice-view-read" {
			// Voice text/history visibility uses View+Read; ConnectVoice is not
			// required to inspect unread state for a voice channel.
			return models.PermViewChannel | models.PermReadMessages, nil
		}
		return models.PermViewChannel | models.PermReadMessages, nil
	}
	rows, err := NewReadStateService(mentionReadRepo{}, resolver).GetUnreadCounts(context.Background(), "owner", "server")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || rows[0].ChannelID != "allowed" || rows[0].MentionCount != 3 || rows[0].OldestUnreadMessageID == nil || *rows[0].OldestUnreadMessageID != "must-not-leak" || rows[1].ChannelID != "voice-view-read" {
		t.Fatalf("leaked or lost mention counts: %+v", rows)
	}
}
