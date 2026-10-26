package services

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
)

type reminderWorkerRepo struct {
	repository.ReminderRepository
	calls atomic.Int32
	seen  chan int32
}

func (r *reminderWorkerRepo) DeliverDue(ctx context.Context, _ time.Time, limit int) ([]models.Notification, error) {
	if _, ok := ctx.Deadline(); !ok || limit != 50 {
		return nil, errors.New("worker must bound delivery timeout and batch")
	}
	n := r.calls.Add(1)
	r.seen <- n
	if n == 1 {
		return nil, errors.New("transient storage failure")
	}
	return nil, nil
}

func TestReminderWorkerRetriesStopsAndRestarts(t *testing.T) {
	repo := &reminderWorkerRepo{seen: make(chan int32, 100)}
	w := NewMessageReminderWorker(repo, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	stop := w.start(ctx, 5*time.Millisecond)
	defer stop()
	for _, want := range []int32{1, 2} {
		select {
		case got := <-repo.seen:
			if got != want {
				t.Fatalf("delivery attempt = %d, want %d", got, want)
			}
		case <-ctx.Done():
			t.Fatal("worker did not retry after storage failure")
		}
	}
	stop()
	before := repo.calls.Load()
	// Drain calls already completed before stop returned.
	for len(repo.seen) > 0 {
		<-repo.seen
	}
	stopAgain := w.start(ctx, time.Hour)
	defer stopAgain()
	select {
	case got := <-repo.seen:
		if got != before+1 {
			t.Fatalf("restart attempt = %d, want %d", got, before+1)
		}
	case <-ctx.Done():
		t.Fatal("worker did not scan overdue reminders immediately on restart")
	}
	stopAgain()
}
