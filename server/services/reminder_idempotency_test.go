package services

import (
	"context"
	"errors"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
	"testing"
	"time"
)

type reminderReplayRepo struct {
	repository.ReminderRepository
	stored  map[string]models.MessageReminder
	creates int
}

func (r *reminderReplayRepo) GetByID(_ context.Context, owner, id string) (*models.MessageReminder, error) {
	m, ok := r.stored[id]
	if !ok || m.UserID != owner {
		return nil, pkg.ErrNotFound
	}
	return &m, nil
}
func (r *reminderReplayRepo) Create(_ context.Context, m *models.MessageReminder) error {
	r.creates++
	r.stored[m.ID] = *m
	return nil
}
func TestReminderServiceStableIdentityAndLateReplay(t *testing.T) {
	now := time.Date(2026, 10, 24, 0, 0, 0, 0, time.UTC)
	repo := &reminderReplayRepo{stored: map[string]models.MessageReminder{}}
	dm := &testutil.MockDMRepo{GetMessageByIDFn: func(context.Context, string) (*models.DMMessage, error) {
		return &models.DMMessage{DMChannelID: "room"}, nil
	}, GetChannelByIDFn: func(context.Context, string) (*models.DMChannel, error) {
		return &models.DMChannel{User1ID: "owner", User2ID: "other"}, nil
	}}
	s := NewReminderService(repo, nil, nil, dm, nil).(*reminderService)
	s.now = func() time.Time { return now }
	req := &models.CreateMessageReminderRequest{RequestID: "6c14df1b-1563-4c65-b460-82aa74fcfb18", SourceKind: "dm", ChannelID: "room", MessageID: "msg", DueAt: now.Add(time.Hour).Format(time.RFC3339)}
	first, err := s.Create(context.Background(), "owner", req)
	if err != nil {
		t.Fatal(err)
	}
	other, err := s.Create(context.Background(), "other", req)
	if err != nil || other.ID == first.ID || other.UserID != "other" {
		t.Fatalf("owner-scoped identity: %+v %v", other, err)
	}
	now = now.Add(2 * time.Hour)
	again, err := s.Create(context.Background(), "owner", req)
	if err != nil || again.ID != first.ID || repo.creates != 2 {
		t.Fatalf("late replay %+v %v creates=%d", again, err, repo.creates)
	}
	for _, status := range []string{models.ReminderStatusCancelled, models.ReminderStatusDelivered} {
		stored := repo.stored[first.ID]
		stored.Status = status
		repo.stored[first.ID] = stored
		replayed, err := s.Create(context.Background(), "owner", req)
		if err != nil || replayed.Status != status || repo.creates != 2 {
			t.Fatalf("terminal state revived: %+v %v", replayed, err)
		}
	}
	changed := *req
	changed.MessageID = "changed"
	if _, err := s.Create(context.Background(), "owner", &changed); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("payload mismatch %v", err)
	}
	bad := *req
	bad.RequestID = "invalid"
	if _, err := s.Create(context.Background(), "owner", &bad); !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("invalid key %v", err)
	}
}
