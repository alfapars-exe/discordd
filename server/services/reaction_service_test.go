package services

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
)

func newTestReactionService(
	reactionRepo *testutil.MockReactionRepo,
	msgRepo *testutil.MockMessageRepo,
	chanRepo *testutil.MockChannelRepo,
	hub *testutil.MockBroadcastAndOnline,
	permResolver ChannelPermResolver,
) ReactionService {
	return NewReactionService(reactionRepo, msgRepo, chanRepo, hub, permResolver)
}

// readResolver grants ViewChannel+ReadMessages — the precondition ToggleReaction
// now enforces for the acting user (matches PinService.GetPinnedMessages).
func readResolver() *testutil.MockChannelPermResolver {
	return &testutil.MockChannelPermResolver{
		ResolveChannelPermissionsFn: func(_ context.Context, _, _ string) (models.Permission, error) {
			return models.PermViewChannel | models.PermReadMessages, nil
		},
	}
}

// ─── Cross-tenant IDOR: message's channel belongs to a different server (H-03) ───
//
// Regression guard for the BOLA where ToggleReaction trusted the path's
// messageId without ever checking that its channel belonged to the path's
// serverId — a caller with membership on server A could toggle a reaction on
// a message living in a channel on server B.

func TestToggleReactionCrossServerChannel(t *testing.T) {
	crossServerChannelRepo := &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
			return &models.Channel{ID: "ch1", ServerID: "other-srv"}, nil
		},
	}

	var toggleCalled bool
	svc := newTestReactionService(
		&testutil.MockReactionRepo{
			ToggleFn: func(_ context.Context, _, _, _ string) (bool, error) {
				toggleCalled = true
				return true, nil
			},
		},
		&testutil.MockMessageRepo{
			GetByIDFn: func(_ context.Context, _ string) (*models.Message, error) {
				return &models.Message{ID: "m1", ChannelID: "ch1"}, nil
			},
		},
		crossServerChannelRepo,
		&testutil.MockBroadcastAndOnline{},
		readResolver(),
	)

	err := svc.ToggleReaction(context.Background(), "srv1", "m1", "u1", "👍")
	if !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("ToggleReaction cross-server: expected ErrNotFound, got %v", err)
	}
	if toggleCalled {
		t.Error("the reaction must not be written when the channel belongs to a different server")
	}
}

// ─── In-server but insufficient channel permissions ───

func TestToggleReactionMissingReadPermission(t *testing.T) {
	sameServerChannelRepo := &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
			return &models.Channel{ID: "ch1", ServerID: "srv1"}, nil
		},
	}

	var toggleCalled bool
	svc := newTestReactionService(
		&testutil.MockReactionRepo{
			ToggleFn: func(_ context.Context, _, _, _ string) (bool, error) {
				toggleCalled = true
				return true, nil
			},
		},
		&testutil.MockMessageRepo{
			GetByIDFn: func(_ context.Context, _ string) (*models.Message, error) {
				return &models.Message{ID: "m1", ChannelID: "ch1"}, nil
			},
		},
		sameServerChannelRepo,
		&testutil.MockBroadcastAndOnline{},
		&testutil.MockChannelPermResolver{
			ResolveChannelPermissionsFn: func(_ context.Context, _, _ string) (models.Permission, error) {
				return models.PermSendMessages, nil // no ViewChannel/ReadMessages
			},
		},
	)

	err := svc.ToggleReaction(context.Background(), "srv1", "m1", "u1", "👍")
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Errorf("ToggleReaction missing perms: expected ErrForbidden, got %v", err)
	}
	if toggleCalled {
		t.Error("the reaction must not be written without channel read permission")
	}
}

// ─── Happy path: existing behavior preserved once the scope check passes ───

func TestToggleReactionHappyPath(t *testing.T) {
	sameServerChannelRepo := &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
			return &models.Channel{ID: "ch1", ServerID: "srv1"}, nil
		},
	}

	var toggleCalled bool
	svc := newTestReactionService(
		&testutil.MockReactionRepo{
			ToggleFn: func(_ context.Context, messageID, userID, emoji string) (bool, error) {
				toggleCalled = true
				if messageID != "m1" || userID != "u1" || emoji != "👍" {
					t.Errorf("unexpected Toggle args: %s %s %s", messageID, userID, emoji)
				}
				return true, nil
			},
			GetByMessageIDFn: func(_ context.Context, _ string) ([]models.ReactionGroup, error) {
				return []models.ReactionGroup{{Emoji: "👍", Count: 1}}, nil
			},
		},
		&testutil.MockMessageRepo{
			GetByIDFn: func(_ context.Context, _ string) (*models.Message, error) {
				return &models.Message{ID: "m1", ChannelID: "ch1"}, nil
			},
		},
		sameServerChannelRepo,
		&testutil.MockBroadcastAndOnline{},
		readResolver(),
	)

	err := svc.ToggleReaction(context.Background(), "srv1", "m1", "u1", "👍")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !toggleCalled {
		t.Error("expected repo Toggle to be called")
	}
}
