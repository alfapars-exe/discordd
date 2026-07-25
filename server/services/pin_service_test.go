package services

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
)

func newTestPinService(
	pinRepo *testutil.MockPinRepo,
	msgRepo *testutil.MockMessageRepo,
	chanRepo *testutil.MockChannelRepo,
	hub *testutil.MockBroadcastAndOnline,
	permResolver ChannelPermResolver,
) PinService {
	return NewPinService(pinRepo, msgRepo, chanRepo, hub, permResolver)
}

// ─── Cross-tenant IDOR: channel belongs to a different server than the URL ───
//
// Regression guard for the BOLA where Pin/Unpin/GetPinnedMessages trusted the
// path's channelId without ever checking it against the path's serverId — a
// caller with ManageMessages on server A could pin/unpin/list messages in a
// channel that actually lives on server B.

func TestPinCrossServerChannel(t *testing.T) {
	crossServerChannelRepo := &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
			return &models.Channel{ID: "ch1", ServerID: "other-srv"}, nil
		},
	}

	svc := newTestPinService(
		&testutil.MockPinRepo{},
		&testutil.MockMessageRepo{
			GetByIDFn: func(_ context.Context, _ string) (*models.Message, error) {
				return &models.Message{ID: "m1", ChannelID: "ch1"}, nil
			},
		},
		crossServerChannelRepo,
		&testutil.MockBroadcastAndOnline{},
		&testutil.MockChannelPermResolver{},
	)

	_, err := svc.Pin(context.Background(), "srv1", "m1", "ch1", "u1")
	if !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("Pin cross-server: expected ErrNotFound, got %v", err)
	}
}

func TestUnpinCrossServerChannel(t *testing.T) {
	crossServerChannelRepo := &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
			return &models.Channel{ID: "ch1", ServerID: "other-srv"}, nil
		},
	}

	svc := newTestPinService(
		&testutil.MockPinRepo{},
		&testutil.MockMessageRepo{
			GetByIDFn: func(_ context.Context, _ string) (*models.Message, error) {
				return &models.Message{ID: "m1", ChannelID: "ch1"}, nil
			},
		},
		crossServerChannelRepo,
		&testutil.MockBroadcastAndOnline{},
		&testutil.MockChannelPermResolver{},
	)

	err := svc.Unpin(context.Background(), "srv1", "m1", "ch1")
	if !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("Unpin cross-server: expected ErrNotFound, got %v", err)
	}
}

func TestGetPinnedMessagesCrossServerChannel(t *testing.T) {
	crossServerChannelRepo := &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
			return &models.Channel{ID: "ch1", ServerID: "other-srv"}, nil
		},
	}

	svc := newTestPinService(
		&testutil.MockPinRepo{},
		&testutil.MockMessageRepo{},
		crossServerChannelRepo,
		&testutil.MockBroadcastAndOnline{},
		&testutil.MockChannelPermResolver{},
	)

	_, err := svc.GetPinnedMessages(context.Background(), "srv1", "ch1", "u1")
	if !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("GetPinnedMessages cross-server: expected ErrNotFound, got %v", err)
	}
}

// ─── In-server but insufficient channel permissions ───

func TestGetPinnedMessagesMissingReadPermission(t *testing.T) {
	sameServerChannelRepo := &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
			return &models.Channel{ID: "ch1", ServerID: "srv1"}, nil
		},
	}

	svc := newTestPinService(
		&testutil.MockPinRepo{},
		&testutil.MockMessageRepo{},
		sameServerChannelRepo,
		&testutil.MockBroadcastAndOnline{},
		&testutil.MockChannelPermResolver{
			ResolveChannelPermissionsFn: func(_ context.Context, _, _ string) (models.Permission, error) {
				return models.PermSendMessages, nil // no ViewChannel/ReadMessages
			},
		},
	)

	_, err := svc.GetPinnedMessages(context.Background(), "srv1", "ch1", "u1")
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Errorf("GetPinnedMessages missing perms: expected ErrForbidden, got %v", err)
	}
}

// ─── Happy paths: existing behavior preserved once the scope check passes ───

func TestPinHappyPath(t *testing.T) {
	sameServerChannelRepo := &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
			return &models.Channel{ID: "ch1", ServerID: "srv1"}, nil
		},
	}

	var pinCalled bool
	svc := newTestPinService(
		&testutil.MockPinRepo{
			PinFn: func(_ context.Context, _ *models.PinnedMessage) error {
				pinCalled = true
				return nil
			},
		},
		&testutil.MockMessageRepo{
			GetByIDFn: func(_ context.Context, _ string) (*models.Message, error) {
				return &models.Message{ID: "m1", ChannelID: "ch1"}, nil
			},
		},
		sameServerChannelRepo,
		&testutil.MockBroadcastAndOnline{},
		&testutil.MockChannelPermResolver{},
	)

	pin, err := svc.Pin(context.Background(), "srv1", "m1", "ch1", "u1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !pinCalled {
		t.Error("expected repo Pin to be called")
	}
	if pin.MessageID != "m1" || pin.ChannelID != "ch1" || pin.PinnedBy != "u1" {
		t.Errorf("unexpected pin result: %+v", pin)
	}
}

func TestPinMessageNotInChannel(t *testing.T) {
	sameServerChannelRepo := &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
			return &models.Channel{ID: "ch1", ServerID: "srv1"}, nil
		},
	}

	svc := newTestPinService(
		&testutil.MockPinRepo{},
		&testutil.MockMessageRepo{
			GetByIDFn: func(_ context.Context, _ string) (*models.Message, error) {
				return &models.Message{ID: "m1", ChannelID: "different-channel"}, nil
			},
		},
		sameServerChannelRepo,
		&testutil.MockBroadcastAndOnline{},
		&testutil.MockChannelPermResolver{},
	)

	_, err := svc.Pin(context.Background(), "srv1", "m1", "ch1", "u1")
	if !errors.Is(err, pkg.ErrBadRequest) {
		t.Errorf("expected ErrBadRequest for message/channel mismatch, got %v", err)
	}
}

func TestPinLimitReached(t *testing.T) {
	sameServerChannelRepo := &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
			return &models.Channel{ID: "ch1", ServerID: "srv1"}, nil
		},
	}

	svc := newTestPinService(
		&testutil.MockPinRepo{
			CountByChannelIDFn: func(_ context.Context, _ string) (int, error) {
				return MaxPinsPerChannel, nil
			},
		},
		&testutil.MockMessageRepo{
			GetByIDFn: func(_ context.Context, _ string) (*models.Message, error) {
				return &models.Message{ID: "m1", ChannelID: "ch1"}, nil
			},
		},
		sameServerChannelRepo,
		&testutil.MockBroadcastAndOnline{},
		&testutil.MockChannelPermResolver{},
	)

	_, err := svc.Pin(context.Background(), "srv1", "m1", "ch1", "u1")
	if !errors.Is(err, pkg.ErrBadRequest) {
		t.Errorf("expected ErrBadRequest at pin limit, got %v", err)
	}
}

func TestUnpinHappyPath(t *testing.T) {
	sameServerChannelRepo := &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
			return &models.Channel{ID: "ch1", ServerID: "srv1"}, nil
		},
	}

	var unpinCalled bool
	svc := newTestPinService(
		&testutil.MockPinRepo{
			UnpinFn: func(_ context.Context, _ string) error {
				unpinCalled = true
				return nil
			},
		},
		&testutil.MockMessageRepo{
			GetByIDFn: func(_ context.Context, _ string) (*models.Message, error) {
				return &models.Message{ID: "m1", ChannelID: "ch1"}, nil
			},
		},
		sameServerChannelRepo,
		&testutil.MockBroadcastAndOnline{},
		&testutil.MockChannelPermResolver{},
	)

	if err := svc.Unpin(context.Background(), "srv1", "m1", "ch1"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !unpinCalled {
		t.Error("expected repo Unpin to be called")
	}
}

func TestGetPinnedMessagesHappyPath(t *testing.T) {
	sameServerChannelRepo := &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
			return &models.Channel{ID: "ch1", ServerID: "srv1"}, nil
		},
	}
	want := []models.PinnedMessageWithDetails{
		{PinnedMessage: models.PinnedMessage{MessageID: "m1", ChannelID: "ch1"}},
	}

	svc := newTestPinService(
		&testutil.MockPinRepo{
			GetByChannelIDFn: func(_ context.Context, _ string) ([]models.PinnedMessageWithDetails, error) {
				return want, nil
			},
		},
		&testutil.MockMessageRepo{},
		sameServerChannelRepo,
		&testutil.MockBroadcastAndOnline{},
		&testutil.MockChannelPermResolver{
			ResolveChannelPermissionsFn: func(_ context.Context, _, _ string) (models.Permission, error) {
				return models.PermViewChannel | models.PermReadMessages, nil
			},
		},
	)

	got, err := svc.GetPinnedMessages(context.Background(), "srv1", "ch1", "u1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 1 || got[0].MessageID != "m1" {
		t.Errorf("unexpected pinned messages: %+v", got)
	}
}
