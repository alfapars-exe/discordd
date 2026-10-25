package services

import (
	"context"
	"errors"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"testing"
)

func TestDMDeletionReceiptRequiresAuthorizationAndCommit(t *testing.T) {
	for _, outcome := range []string{"success", "not_owner", "not_member", "commit_failed"} {
		t.Run(outcome, func(t *testing.T) {
			f := newDMFixture()
			f.repo.GetMessageByIDFn = func(context.Context, string) (*models.DMMessage, error) {
				owner := "alice"
				if outcome == "not_owner" {
					owner = "bob"
				}
				return &models.DMMessage{ID: "m", DMChannelID: "ch", UserID: owner}, nil
			}
			f.repo.GetChannelByIDFn = func(context.Context, string) (*models.DMChannel, error) {
				if outcome == "not_member" {
					return &models.DMChannel{ID: "ch", User1ID: "bob", User2ID: "charlie"}, nil
				}
				return &models.DMChannel{ID: "ch", User1ID: "alice", User2ID: "bob"}, nil
			}
			deleted := false
			f.repo.DeleteMessageFn = func(context.Context, string) error {
				if outcome == "commit_failed" {
					return errors.New("commit failed")
				}
				deleted = true
				return nil
			}
			receipt, err := f.svc.(DMDeletionReceiptService).DeleteMessageWithReceipt(context.Background(), "alice", "m")
			if outcome != "success" {
				if err == nil || receipt != nil || deleted {
					t.Fatalf("unexpected failed deletion receipt=%v err=%v deleted=%v", receipt, err, deleted)
				}
				if (outcome == "not_owner" || outcome == "not_member") && !errors.Is(err, pkg.ErrForbidden) {
					t.Fatal(err)
				}
				return
			}
			if err != nil || !deleted || receipt == nil || receipt.ID != "m" || receipt.DMChannelID != "ch" || receipt.Message != "message deleted" {
				t.Fatalf("receipt=%v err=%v deleted=%v", receipt, err, deleted)
			}
		})
	}
}
