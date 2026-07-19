// Maintenance sweeper tests — P1-BD-04 regression: expired sessions and
// stale link previews must actually get purged (DeleteExpired previously had
// no caller anywhere in the codebase).
package main

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/testutil"
)

// mockLinkPreviewRepo — minimal in-file mock (testutil has no link-preview mock).
type mockLinkPreviewRepo struct {
	deleteExpiredFn func(ctx context.Context, olderThan time.Time) (int64, error)
}

func (m *mockLinkPreviewRepo) GetByURL(context.Context, string) (*models.LinkPreview, error) {
	return nil, nil
}
func (m *mockLinkPreviewRepo) Upsert(context.Context, *models.LinkPreview) error { return nil }
func (m *mockLinkPreviewRepo) DeleteExpired(ctx context.Context, olderThan time.Time) (int64, error) {
	if m.deleteExpiredFn != nil {
		return m.deleteExpiredFn(ctx, olderThan)
	}
	return 0, nil
}

func TestMaintenanceSweeper_SweepsImmediatelyAndStops(t *testing.T) {
	var sessionSweeps, previewSweeps atomic.Int32
	sessions := &testutil.MockSessionRepo{
		DeleteExpiredFn: func(context.Context) error {
			sessionSweeps.Add(1)
			return nil
		},
	}
	var gotOlderThan atomic.Value
	previews := &mockLinkPreviewRepo{
		deleteExpiredFn: func(_ context.Context, olderThan time.Time) (int64, error) {
			previewSweeps.Add(1)
			gotOlderThan.Store(olderThan)
			return 3, nil
		},
	}

	stop := startMaintenanceSweeper(sessions, previews, nil, time.Hour)
	defer stop()

	deadline := time.Now().Add(2 * time.Second)
	for (sessionSweeps.Load() == 0 || previewSweeps.Load() == 0) && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if sessionSweeps.Load() != 1 || previewSweeps.Load() != 1 {
		t.Fatalf("expected exactly one boot sweep each, got sessions=%d previews=%d",
			sessionSweeps.Load(), previewSweeps.Load())
	}

	cutoff, _ := gotOlderThan.Load().(time.Time)
	wantApprox := time.Now().Add(-linkPreviewRetention)
	if cutoff.Before(wantApprox.Add(-time.Minute)) || cutoff.After(wantApprox.Add(time.Minute)) {
		t.Errorf("preview cutoff = %v, want ~%v", cutoff, wantApprox)
	}
}

func TestMaintenanceSweeper_ErrorsAreNonFatal(t *testing.T) {
	var calls atomic.Int32
	sessions := &testutil.MockSessionRepo{
		DeleteExpiredFn: func(context.Context) error {
			calls.Add(1)
			return errors.New("db down")
		},
	}
	previews := &mockLinkPreviewRepo{
		deleteExpiredFn: func(context.Context, time.Time) (int64, error) {
			return 0, errors.New("db down")
		},
	}

	// Must not panic; the sweep keeps going on the next tick.
	stop := startMaintenanceSweeper(sessions, previews, nil, 20*time.Millisecond)
	defer stop()

	deadline := time.Now().Add(2 * time.Second)
	for calls.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if calls.Load() < 2 {
		t.Fatal("sweeper stopped after an error; expected it to keep ticking")
	}
}
