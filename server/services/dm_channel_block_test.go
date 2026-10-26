package services

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/ws"
)

func TestDMNewChannelBlockCheckPreventsCreationAndEvents(t *testing.T) {
	for _, scenario := range []string{"sender_blocks", "recipient_blocks", "lookup_failure", "allowed", "admin"} {
		t.Run(scenario, func(t *testing.T) {
			f := newDMFixture()
			f.users.GetByIDFn = func(_ context.Context, id string) (*models.User, error) {
				return &models.User{ID: id, DMPrivacy: "everyone", IsPlatformAdmin: scenario == "admin" && id == "alice"}, nil
			}
			f.repo.GetChannelByUsersFn = func(context.Context, string, string) (*models.DMChannel, error) { return nil, nil }
			failure := errors.New("block lookup failed")
			checks, creates, events := 0, 0, 0
			f.block.IsBlockedFn = func(_ context.Context, a, b string) (bool, error) {
				checks++
				if a != "alice" || b != "bob" {
					t.Fatalf("wrong block pair %q %q", a, b)
				}
				if scenario == "lookup_failure" {
					return false, failure
				}
				return scenario != "allowed", nil
			}
			f.repo.CreateChannelFn = func(context.Context, *models.DMChannel) error { creates++; return nil }
			f.hub.BroadcastToUserFn = func(string, ws.Event) { events++ }
			channel, err := f.svc.GetOrCreateChannel(context.Background(), "alice", "bob")
			if scenario == "allowed" || scenario == "admin" {
				if err != nil || channel == nil || creates != 1 || events != 2 {
					t.Fatalf("allowed channel=%v err=%v creates=%d events=%d", channel, err, creates, events)
				}
				if scenario == "admin" && checks != 0 {
					t.Fatal("existing admin semantics changed")
				}
				return
			}
			if err == nil || channel != nil || creates != 0 || events != 0 || checks != 1 {
				t.Fatalf("blocked channel=%v err=%v creates=%d events=%d checks=%d", channel, err, creates, events, checks)
			}
			if scenario == "lookup_failure" {
				if !errors.Is(err, failure) {
					t.Fatal(err)
				}
			} else if !errors.Is(err, pkg.ErrForbidden) {
				t.Fatal(err)
			}
		})
	}
}

func TestDMExistingBlockedChannelRetainsHistoryWithoutCreateEvent(t *testing.T) {
	f := newDMFixture()
	f.users.GetByIDFn = func(_ context.Context, id string) (*models.User, error) { return &models.User{ID: id}, nil }
	f.repo.GetChannelByUsersFn = func(context.Context, string, string) (*models.DMChannel, error) {
		return &models.DMChannel{ID: "history", User1ID: "alice", User2ID: "bob", E2EEEnabled: true, Status: models.DMStatusAccepted}, nil
	}
	f.block.IsBlockedFn = func(context.Context, string, string) (bool, error) { return true, nil }
	f.repo.CreateChannelFn = func(context.Context, *models.DMChannel) error { t.Fatal("recreated history"); return nil }
	f.hub.BroadcastToUserFn = func(string, ws.Event) { t.Fatal("unexpected event") }
	channel, err := f.svc.GetOrCreateChannel(context.Background(), "alice", "bob")
	if err != nil || channel == nil || channel.ID != "history" || !channel.E2EEEnabled {
		t.Fatalf("history=%v err=%v", channel, err)
	}
}
