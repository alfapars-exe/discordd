package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
)

type threadPermStub struct{ p models.Permission }

func (s threadPermStub) ResolveChannelPermissions(context.Context, string, string) (models.Permission, error) {
	return s.p, nil
}
func (s threadPermStub) ResolveChannelPermissionsBulk(context.Context, string, []string) (map[string]models.Permission, error) {
	return nil, nil
}

func TestThreadServiceCreateUsesParentAndStarter(t *testing.T) {
	var created *models.Channel
	channels := &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
			return &models.Channel{ID: id, ServerID: "s", Type: models.ChannelTypeText}, nil
		},
		CreateFn: func(_ context.Context, channel *models.Channel) error {
			channel.ID = "thread"
			created = channel
			return nil
		},
	}
	messages := &testutil.MockMessageRepo{GetByIDFn: func(context.Context, string) (*models.Message, error) {
		return &models.Message{ID: "m", ChannelID: "parent"}, nil
	}}
	svc := NewThreadService(channels, messages, threadPermStub{models.PermViewChannel | models.PermReadMessages | models.PermSendMessages}, &testutil.MockBroadcaster{})
	got, err := svc.Create(context.Background(), "s", "parent", "u", &models.CreateThreadRequest{Name: " topic ", MessageID: "m"})
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != "thread" || created.Type != models.ChannelTypeThread || *created.ParentChannelID != "parent" || *created.StarterMessageID != "m" || created.Name != "topic" {
		t.Fatalf("unexpected thread: %#v", created)
	}
}

func TestThreadServiceRejectsCrossChannelStarter(t *testing.T) {
	channels := &testutil.MockChannelRepo{GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
		return &models.Channel{ID: id, ServerID: "s", Type: models.ChannelTypeText}, nil
	}}
	messages := &testutil.MockMessageRepo{GetByIDFn: func(context.Context, string) (*models.Message, error) {
		return &models.Message{ID: "m", ChannelID: "other"}, nil
	}}
	svc := NewThreadService(channels, messages, threadPermStub{models.PermAll}, &testutil.MockBroadcaster{})
	_, err := svc.Create(context.Background(), "s", "parent", "u", &models.CreateThreadRequest{Name: "topic", MessageID: "m"})
	if !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("expected not found, got %v", err)
	}
}

func TestThreadLifecycleStarterOrModeratorOnly(t *testing.T) {
	parent, starter := "parent", "m"
	archived := false
	channels := &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
			return &models.Channel{ID: id, ServerID: "s", Type: models.ChannelTypeThread, ParentChannelID: &parent, StarterMessageID: &starter}, nil
		},
		SetThreadArchivedFn: func(_ context.Context, _ string, value bool) error { archived = value; return nil },
	}
	messages := &testutil.MockMessageRepo{GetByIDFn: func(context.Context, string) (*models.Message, error) { return &models.Message{UserID: "owner"}, nil }}
	svc := NewThreadService(channels, messages, threadPermStub{models.PermViewChannel | models.PermReadMessages}, &testutil.MockBroadcaster{})
	if _, err := svc.SetArchived(context.Background(), "s", "thread", "other", true); !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("expected forbidden, got %v", err)
	}
	if _, err := svc.SetArchived(context.Background(), "s", "thread", "owner", true); err != nil || !archived {
		t.Fatalf("starter should archive: %v", err)
	}
}

func TestThreadGetRequiresValidSameServerTextParentAndReadPermission(t *testing.T) {
	parentID := "parent"
	archivedAt := time.Date(2026, 10, 25, 12, 0, 0, 0, time.UTC)
	thread := &models.Channel{ID: "thread", ServerID: "s", Type: models.ChannelTypeThread, ParentChannelID: &parentID, ArchivedAt: &archivedAt}
	parent := &models.Channel{ID: "parent", ServerID: "s", Type: models.ChannelTypeText}

	t.Run("archived thread remains readable", func(t *testing.T) {
		channels := &testutil.MockChannelRepo{GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
			if id == "thread" {
				return thread, nil
			}
			return parent, nil
		}}
		perms := &threadPermRecorder{p: models.PermViewChannel | models.PermReadMessages}
		svc := NewThreadService(channels, &testutil.MockMessageRepo{}, perms, &testutil.MockBroadcaster{})
		got, err := svc.Get(context.Background(), "s", "thread", "member")
		if err != nil || got != thread {
			t.Fatalf("Get() = %#v, %v; want archived thread", got, err)
		}
		if perms.channelID != "parent" || perms.userID != "member" {
			t.Fatalf("permission check used (%q,%q), want member and parent", perms.userID, perms.channelID)
		}
	})

	for _, tc := range []struct {
		name    string
		thread  *models.Channel
		parent  *models.Channel
		wantErr error
	}{
		{name: "wrong server", thread: &models.Channel{ID: "thread", ServerID: "other", Type: models.ChannelTypeThread, ParentChannelID: &parentID}, parent: parent, wantErr: pkg.ErrNotFound},
		{name: "not a thread", thread: &models.Channel{ID: "thread", ServerID: "s", Type: models.ChannelTypeText}, parent: parent, wantErr: pkg.ErrNotFound},
		{name: "missing parent", thread: &models.Channel{ID: "thread", ServerID: "s", Type: models.ChannelTypeThread}, wantErr: pkg.ErrNotFound},
		{name: "parent missing", thread: thread, wantErr: pkg.ErrNotFound},
		{name: "parent in another server", thread: thread, parent: &models.Channel{ID: "parent", ServerID: "other", Type: models.ChannelTypeText}, wantErr: pkg.ErrNotFound},
		{name: "parent not text", thread: thread, parent: &models.Channel{ID: "parent", ServerID: "s", Type: models.ChannelTypeThread}, wantErr: pkg.ErrNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			channels := &testutil.MockChannelRepo{GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
				if id == "thread" {
					return tc.thread, nil
				}
				return tc.parent, nil
			}}
			svc := NewThreadService(channels, &testutil.MockMessageRepo{}, threadPermStub{models.PermAll}, &testutil.MockBroadcaster{})
			if _, err := svc.Get(context.Background(), "s", "thread", "member"); !errors.Is(err, tc.wantErr) {
				t.Fatalf("Get() error = %v, want %v", err, tc.wantErr)
			}
		})
	}

	t.Run("nonmember or unreadable parent is forbidden", func(t *testing.T) {
		channels := &testutil.MockChannelRepo{GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
			if id == "thread" {
				return thread, nil
			}
			return parent, nil
		}}
		svc := NewThreadService(channels, &testutil.MockMessageRepo{}, threadPermStub{0}, &testutil.MockBroadcaster{})
		if _, err := svc.Get(context.Background(), "s", "thread", "outsider"); !errors.Is(err, pkg.ErrForbidden) {
			t.Fatalf("Get() error = %v, want forbidden", err)
		}
	})
}

type threadPermRecorder struct {
	p         models.Permission
	userID    string
	channelID string
}

func (s *threadPermRecorder) ResolveChannelPermissions(_ context.Context, userID, channelID string) (models.Permission, error) {
	s.userID, s.channelID = userID, channelID
	return s.p, nil
}
func (s *threadPermRecorder) ResolveChannelPermissionsBulk(context.Context, string, []string) (map[string]models.Permission, error) {
	return nil, nil
}
