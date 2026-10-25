package services

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
)

type groupAroundFixture struct {
	repository.GroupDMRepository
	member bool
	calls  int
	items  []models.GroupDMMessage
	before bool
	after  bool
}

func (f *groupAroundFixture) ListForUser(context.Context, string) ([]models.GroupDM, error) {
	return []models.GroupDM{{ID: "group"}}, nil
}

func (f *groupAroundFixture) ListMemberIDs(context.Context, string) ([]string, error) {
	return []string{"reader"}, nil
}

func (f *groupAroundFixture) GetReadState(_ context.Context, groupID, userID string) (*models.GroupDMReadState, error) {
	if groupID != "group" || userID != "reader" {
		return nil, pkg.ErrNotFound
	}
	anchor := "unread-anchor"
	return &models.GroupDMReadState{GroupID: groupID, UnreadCount: 2, Revision: 3, OldestUnreadMessageID: &anchor}, nil
}

func (f *groupAroundFixture) GetByID(_ context.Context, id string) (*models.GroupDM, error) {
	return &models.GroupDM{ID: id}, nil
}

func (f *groupAroundFixture) IsMember(context.Context, string, string) (bool, error) {
	return f.member, nil
}

func (f *groupAroundFixture) GetMessagesAround(_ context.Context, _, anchor string, limit int) ([]models.GroupDMMessage, bool, bool, error) {
	f.calls++
	if anchor != "anchor" || limit != 50 {
		return nil, false, false, errors.New("unexpected around query")
	}
	return append([]models.GroupDMMessage(nil), f.items...), f.before, f.after, nil
}

func (f *groupAroundFixture) GetReactions(_ context.Context, ids []string) (map[string][]models.ReactionGroup, error) {
	return map[string][]models.ReactionGroup{"message": {{Emoji: "👍", Count: 1}}}, nil
}

func (f *groupAroundFixture) GetAttachments(_ context.Context, ids []string) (map[string][]models.GroupDMAttachment, error) {
	return map[string][]models.GroupDMAttachment{"message": {{ID: "attachment", FileKeyIndex: groupAroundIntPtr(2)}}}, nil
}

func TestGroupDMGetMessagesAroundRequiresMembershipAndEnrichesPage(t *testing.T) {
	groupRepo := &groupAroundFixture{
		member: true,
		items:  []models.GroupDMMessage{{ID: "message", GroupID: "group", UserID: "author", KeyEpoch: 4, Ciphertext: strPtr("cipher")}},
		before: true,
		after:  true,
	}
	users := &testutil.MockUserRepo{GetByIDFn: func(_ context.Context, id string) (*models.User, error) {
		if id != "author" {
			return nil, pkg.ErrNotFound
		}
		return &models.User{ID: id, Username: "author"}, nil
	}}
	svc := &groupDMService{groups: groupRepo, users: users}
	page, err := svc.GetMessagesAround(context.Background(), "group", "reader", "anchor", 0)
	if err != nil {
		t.Fatal(err)
	}
	if groupRepo.calls != 1 || len(page.Messages) != 1 || !page.HasMore || !page.HasMoreAfter {
		t.Fatalf("calls=%d page=%+v", groupRepo.calls, page)
	}
	message := page.Messages[0]
	if message.KeyEpoch != 4 || message.Ciphertext == nil || *message.Ciphertext != "cipher" || message.User == nil || message.User.ID != "author" {
		t.Fatalf("encrypted/authored data not preserved: %+v", message)
	}
	if len(message.Reactions) != 1 || len(message.Attachments) != 1 || message.Attachments[0].FileKeyIndex == nil || *message.Attachments[0].FileKeyIndex != 2 {
		t.Fatalf("message relations were not enriched: %+v", message)
	}

	groupRepo.member = false
	if _, err := svc.GetMessagesAround(context.Background(), "group", "outsider", "anchor", 25); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("nonmember error=%v, want not found", err)
	}
	if groupRepo.calls != 1 {
		t.Fatalf("nonmember reached around repository: calls=%d", groupRepo.calls)
	}
}

func TestGroupDMListIncludesReaderSpecificOldestUnreadAnchor(t *testing.T) {
	groupRepo := &groupAroundFixture{}
	users := &testutil.MockUserRepo{GetByIDFn: func(_ context.Context, id string) (*models.User, error) {
		return &models.User{ID: id, Username: id}, nil
	}}
	svc := &groupDMService{groups: groupRepo, users: users}
	groups, err := svc.List(context.Background(), "reader")
	if err != nil || len(groups) != 1 {
		t.Fatalf("groups=%+v err=%v", groups, err)
	}
	if groups[0].UnreadCount != 2 || groups[0].ReadRevision != 3 || groups[0].OldestUnreadMessageID == nil || *groups[0].OldestUnreadMessageID != "unread-anchor" {
		t.Fatalf("reader unread state not copied to list item: %+v", groups[0])
	}
}

func groupAroundIntPtr(value int) *int { return &value }
