package services

import (
	"context"
	"sync"
	"time"

	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

const (
	friendAnniversaryWorkerInterval = 15 * time.Minute
	friendAnniversaryWorkerTimeout  = 10 * time.Second
	friendAnniversaryPageLimit      = 100
	friendAnniversaryDrainPages     = 20
)

// FriendAnniversaryWorker sends one persisted inbox notice to each side of
// an accepted friendship on its UTC calendar anniversary. February 29
// anniversaries are observed on February 28 in non-leap years.
type FriendAnniversaryWorker struct {
	repo repository.FriendAnniversaryDeliveryRepository
	hub  ws.Broadcaster
	now  func() time.Time

	mu        sync.Mutex
	cursor    string
	cursorDay string
	cancel    context.CancelFunc
	done      chan struct{}
}

func NewFriendAnniversaryWorker(repo repository.FriendAnniversaryDeliveryRepository, hub ws.Broadcaster) *FriendAnniversaryWorker {
	return &FriendAnniversaryWorker{repo: repo, hub: hub, now: time.Now}
}

// Start begins the bounded delivery loop and returns a function that cancels
// it and waits for shutdown.
func (w *FriendAnniversaryWorker) Start(parent context.Context) func() {
	w.mu.Lock()
	if w.cancel != nil {
		cancel, done := w.cancel, w.done
		w.mu.Unlock()
		return func() { cancel(); <-done }
	}
	ctx, cancel := context.WithCancel(parent)
	done := make(chan struct{})
	w.cancel, w.done = cancel, done
	w.mu.Unlock()
	logx.Go("friend_anniversary_notifications", func() {
		defer func() {
			w.mu.Lock()
			w.cancel = nil
			close(done)
			w.mu.Unlock()
		}()
		ticker := time.NewTicker(friendAnniversaryWorkerInterval)
		defer ticker.Stop()
		for {
			if err := w.Drain(ctx); err != nil && ctx.Err() == nil {
				logx.Component("friend_anniversary_notifications").Warn("friend anniversary delivery failed", "err", pkg.ErrText(err))
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	})
	return func() { cancel(); <-done }
}

func (w *FriendAnniversaryWorker) Drain(ctx context.Context) error {
	bounded, cancel := context.WithTimeout(ctx, friendAnniversaryWorkerTimeout)
	defer cancel()
	for page := 0; page < friendAnniversaryDrainPages; page++ {
		if err := w.Tick(bounded); err != nil {
			return err
		}
		w.mu.Lock()
		wrapped := w.cursor == ""
		w.mu.Unlock()
		if wrapped {
			return nil
		}
	}
	return nil
}

func (w *FriendAnniversaryWorker) Tick(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	now := w.now().UTC()
	day := now.Format("01-02")
	includeLeapDay := day == "02-28" && !friendAnniversaryLeapYear(now.Year())
	bounded, cancel := context.WithTimeout(ctx, friendAnniversaryWorkerTimeout)
	defer cancel()

	w.mu.Lock()
	defer w.mu.Unlock()
	if w.cursorDay != day {
		w.cursor = ""
		w.cursorDay = day
	}
	candidates, err := w.repo.DueCandidates(bounded, day, includeLeapDay, w.cursor, friendAnniversaryPageLimit)
	if err != nil {
		return err
	}
	if len(candidates) == 0 {
		w.cursor = ""
		return nil
	}
	for _, candidate := range candidates {
		if err := bounded.Err(); err != nil {
			return err
		}
		years := now.Year() - candidate.AcceptedAt.UTC().Year()
		if years >= 1 && friendAnniversaryDateDue(candidate.AnniversaryDay, now) {
			for _, pair := range [][2]string{{candidate.UserID, candidate.FriendID}, {candidate.FriendID, candidate.UserID}} {
				notification, deliverErr := w.repo.Deliver(bounded, candidate.FriendshipID, now.Year(), pair[0], now)
				if deliverErr != nil {
					// Leave cursor before this candidate so a transient failure is
					// retried on the next bounded run. Successful first-side writes
					// are idempotent through the persisted decision key.
					return deliverErr
				}
				if notification != nil {
					broadcastNotificationCreate(w.hub, notification)
				}
			}
		}
		w.cursor = candidate.FriendshipID
	}
	if len(candidates) < friendAnniversaryPageLimit {
		w.cursor = ""
	}
	return nil
}

func friendAnniversaryDateDue(acceptedDay string, now time.Time) bool {
	if acceptedDay == "02-29" && !friendAnniversaryLeapYear(now.UTC().Year()) {
		return now.UTC().Format("01-02") == "02-28"
	}
	return acceptedDay == now.UTC().Format("01-02")
}

func friendAnniversaryLeapYear(year int) bool {
	return year%4 == 0 && (year%100 != 0 || year%400 == 0)
}
