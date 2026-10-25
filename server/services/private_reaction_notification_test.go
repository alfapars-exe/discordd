package services

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
)

type reactionBlockStub struct {
	BlockChecker
	blocked bool
}

func (b reactionBlockStub) IsBlocked(context.Context, string, string) (bool, error) {
	return b.blocked, nil
}

type reactionGroupStub struct {
	repository.GroupDMRepository
	added, authorMember bool
}

func (r reactionGroupStub) GetByID(context.Context, string) (*models.GroupDM, error) {
	return &models.GroupDM{ID: "group"}, nil
}
func (r reactionGroupStub) IsMember(context.Context, string, string) (bool, error) { return true, nil }
func (r reactionGroupStub) GetMessage(context.Context, string, string) (*models.GroupDMMessage, error) {
	return &models.GroupDMMessage{ID: "message", UserID: "author", GroupID: "group"}, nil
}
func (r reactionGroupStub) ToggleReaction(context.Context, string, string, string) (bool, error) {
	return r.added, nil
}
func (r reactionGroupStub) GetReactions(context.Context, []string) (map[string][]models.ReactionGroup, error) {
	return map[string][]models.ReactionGroup{}, nil
}
func (r reactionGroupStub) ListMemberIDs(context.Context, string) ([]string, error) {
	if r.authorMember {
		return []string{"actor", "author"}, nil
	}
	return []string{"actor"}, nil
}

func TestPrivateReactionNotificationGates(t *testing.T) {
	for _, tc := range []struct {
		name                                  string
		added, blocked, pending, authorMember bool
		want                                  int
	}{
		{"new", true, false, false, true, 1},
		{"removed", false, false, false, true, 0},
		{"blocked", true, true, false, true, 0},
		{"pending", true, false, true, true, 0},
		{"author left", true, false, false, false, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			hub := &testutil.MockBroadcastAndOnline{}
			blocks := reactionBlockStub{blocked: tc.blocked}
			if !tc.pending {
				repo := &reactionDeliveryRepo{created: true}
				group := &groupDMService{groups: reactionGroupStub{added: tc.added, authorMember: tc.authorMember}, hub: hub, reactionBlocks: blocks, reactionPreferences: reactionPrefsStub{"direct"}, reactionNotifications: repo}
				if err := group.ToggleReaction(context.Background(), "group", "message", "actor", "👍"); err != nil {
					t.Fatal(err)
				}
				if repo.calls != tc.want {
					t.Fatalf("group writes=%d want=%d", repo.calls, tc.want)
				}
			}
			if !tc.authorMember {
				return
			}
			repo := &reactionDeliveryRepo{created: true}
			status := models.DMStatusAccepted
			if tc.pending {
				status = models.DMStatusPending
			}
			dm := &dmService{dmRepo: &testutil.MockDMRepo{
				GetMessageByIDFn: func(context.Context, string) (*models.DMMessage, error) {
					return &models.DMMessage{ID: "message", UserID: "author", DMChannelID: "private"}, nil
				},
				GetChannelByIDFn: func(context.Context, string) (*models.DMChannel, error) {
					return &models.DMChannel{ID: "private", User1ID: "actor", User2ID: "author", Status: status}, nil
				},
				ToggleReactionFn: func(context.Context, string, string, string) (bool, error) { return tc.added, nil },
			}, hub: hub, blockChecker: blocks, reactionPreferences: reactionPrefsStub{"direct"}, notificationRepo: repo}
			if err := dm.ToggleReaction(context.Background(), "actor", "message", "👍"); err != nil {
				t.Fatal(err)
			}
			if repo.calls != tc.want {
				t.Fatalf("DM writes=%d want=%d", repo.calls, tc.want)
			}
		})
	}
}

func TestGroupReactionOriginSurvivesPayload(t *testing.T) {
	repo := &reactionDeliveryRepo{created: true}
	actor, message := "actor", "message"
	n := &models.Notification{UserID: "author", Kind: models.NotificationKindSystem, ActorID: &actor, MessageID: &message, Payload: json.RawMessage(`{"group_id":"group"}`)}
	deliverReactionNotification(context.Background(), repo, reactionPrefsStub{"direct"}, nil, &testutil.MockBroadcastAndOnline{}, n, "👍", true)
	var payload map[string]string
	if err := json.Unmarshal(n.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	if payload["group_id"] != "group" || payload["subtype"] != "reaction" {
		t.Fatalf("payload=%s", n.Payload)
	}
}
