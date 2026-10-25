package services

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

type conditionalDMRepo struct {
	*testutil.MockDMRepo
	accept func(context.Context, string) (bool, error)
}

func (r conditionalDMRepo) AcceptPendingUnblocked(ctx context.Context, id string) (bool, error) {
	return r.accept(ctx, id)
}

func TestDMAcceptConditionalWriteGatesSideEffects(t *testing.T) {
	for _, automatic := range []bool{false, true} {
		for _, outcome := range []string{"changed", "unchanged", "failed"} {
			f := newDMFixture()
			pendingChannelFixture(t, f, strPtr("alice"))
			f.repo.GetChannelByUsersFn = func(context.Context, string, string) (*models.DMChannel, error) {
				return &models.DMChannel{ID: "ch-1", User1ID: "alice", User2ID: "bob", Status: models.DMStatusPending}, nil
			}
			f.repo.UpdateChannelStatusFn = func(context.Context, string, string) error { t.Fatal("unconditional fallback used"); return nil }
			failure := errors.New("database failed")
			finished := false
			events := 0
			settled := 0
			f.svc.(*dmService).dmRepo = conditionalDMRepo{MockDMRepo: f.repo, accept: func(_ context.Context, id string) (bool, error) {
				if id != "ch-1" {
					t.Fatalf("wrong channel %s", id)
				}
				finished = true
				if outcome == "failed" {
					return false, failure
				}
				return outcome == "changed", nil
			}}
			f.hub.BroadcastToUserFn = func(_ string, event ws.Event) {
				if !finished || outcome != "changed" {
					t.Fatal("accept event without committed change")
				}
				if event.Op == ws.OpDMRequestAccept {
					events++
				}
			}
			f.notif.MarkDMRequestReadFn = func(context.Context, string, string) ([]string, error) {
				if !finished || outcome != "changed" {
					t.Fatal("notification settled without change")
				}
				settled++
				return nil, nil
			}
			var err error
			if automatic {
				err = f.svc.AcceptPendingChannels(context.Background(), "alice", "bob")
			} else {
				err = f.svc.AcceptRequest(context.Background(), "bob", "ch-1")
			}
			if !finished {
				t.Fatal("conditional writer not called")
			}
			switch outcome {
			case "changed":
				if err != nil || events != 2 || settled == 0 {
					t.Fatalf("success err=%v events=%d settled=%d", err, events, settled)
				}
			case "unchanged":
				if !errors.Is(err, pkg.ErrConflict) {
					t.Fatalf("expected conflict: %v", err)
				}
			case "failed":
				if !errors.Is(err, failure) {
					t.Fatalf("expected failure: %v", err)
				}
			}
		}
	}
}

func TestDMAcceptRequestRejectsBlockBeforeSideEffects(t *testing.T) {
	for _, automatic := range []bool{false, true} {
		for _, lookupFails := range []bool{false, true} {
			f := newDMFixture()
			pendingChannelFixture(t, f, strPtr("alice"))
			f.repo.GetChannelByUsersFn = func(context.Context, string, string) (*models.DMChannel, error) {
				return &models.DMChannel{ID: "ch-1", User1ID: "alice", User2ID: "bob", Status: models.DMStatusPending}, nil
			}
			failure := errors.New("block lookup unavailable")
			f.block.IsBlockedFn = func(_ context.Context, a, b string) (bool, error) {
				if a != "alice" || b != "bob" {
					t.Fatalf("wrong pair %s %s", a, b)
				}
				if lookupFails {
					return false, failure
				}
				return true, nil
			}
			f.repo.UpdateChannelStatusFn = func(context.Context, string, string) error { t.Fatal("blocked request updated"); return nil }
			f.hub.BroadcastToUserFn = func(string, ws.Event) { t.Fatal("blocked request event emitted") }
			f.notif.MarkDMRequestReadFn = func(context.Context, string, string) ([]string, error) {
				t.Fatal("blocked notification settled")
				return nil, nil
			}
			var err error
			if automatic {
				err = f.svc.AcceptPendingChannels(context.Background(), "alice", "bob")
			} else {
				err = f.svc.AcceptRequest(context.Background(), "bob", "ch-1")
			}
			want := pkg.ErrForbidden
			if lookupFails {
				want = failure
			}
			if !errors.Is(err, want) {
				t.Fatalf("automatic=%v lookupFails=%v error=%v", automatic, lookupFails, err)
			}
		}
	}
}
