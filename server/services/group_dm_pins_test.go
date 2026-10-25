package services

import (
	"context"
	"errors"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
	"testing"
)

type groupPinsFixture struct {
	groupAroundFixture
	pinsCalls int
}

func (f *groupPinsFixture) SetMessagePinned(context.Context, string, string, string, bool) error {
	f.pinsCalls++
	return nil
}
func (f *groupPinsFixture) ListPinnedMessages(context.Context, string, string) ([]models.GroupDMMessage, error) {
	f.pinsCalls++
	return append([]models.GroupDMMessage(nil), f.items...), nil
}
func TestGroupPinsServiceMembershipAndEncryptedEnrichment(t *testing.T) {
	f := &groupPinsFixture{groupAroundFixture: groupAroundFixture{member: true, items: []models.GroupDMMessage{{ID: "message", GroupID: "group", UserID: "author", Ciphertext: strPtr("encrypted")}}}}
	s := &groupDMService{groups: f, users: &testutil.MockUserRepo{GetByIDFn: func(context.Context, string) (*models.User, error) {
		return &models.User{ID: "author", Username: "author"}, nil
	}}}
	items, err := s.ListPinnedMessages(context.Background(), "group", "reader")
	if err != nil || len(items) != 1 || items[0].User == nil || len(items[0].Attachments) != 1 || *items[0].Ciphertext != "encrypted" {
		t.Fatalf("items=%#v err=%v", items, err)
	}
	if err = s.SetMessagePinned(context.Background(), "group", "reader", "message", true); err != nil {
		t.Fatal(err)
	}
	f.member = false
	if _, err = s.ListPinnedMessages(context.Background(), "group", "reader"); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("revoked list=%v", err)
	}
	if err = s.SetMessagePinned(context.Background(), "group", "reader", "message", false); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("revoked unpin=%v", err)
	}
	if f.pinsCalls != 2 {
		t.Fatalf("revoked member reached repo: calls=%d", f.pinsCalls)
	}
}
