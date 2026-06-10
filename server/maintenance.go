package main

import (
	"context"
	"time"

	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/repository"
)

// linkPreviewRetention is how long link-preview cache rows are kept. The
// read path treats rows older than 24h as stale (re-fetches), so anything
// past a week is pure dead weight.
const linkPreviewRetention = 7 * 24 * time.Hour

// startMaintenanceSweeper purges time-expired rows that previously had no
// caller (audit P1-BD-04): expired sessions and stale link-preview cache
// entries accumulated forever. Sweeps once at boot, then every interval.
// Errors are logged, never fatal. Returns a stop func for graceful shutdown
// (mirrors startRuntimeStatsLogger).
func startMaintenanceSweeper(
	sessions repository.SessionRepository,
	previews repository.LinkPreviewRepository,
	interval time.Duration,
) func() {
	stop := make(chan struct{})
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		logger := logx.Component("maintenance")

		sweep := func() {
			ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
			defer cancel()
			if err := sessions.DeleteExpired(ctx); err != nil {
				logger.Error("expired session sweep failed", "error", err)
			}
			deleted, err := previews.DeleteExpired(ctx, time.Now().Add(-linkPreviewRetention))
			if err != nil {
				logger.Error("link preview sweep failed", "error", err)
			} else if deleted > 0 {
				logger.Info("link preview sweep", "deleted_rows", deleted)
			}
		}

		sweep()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				sweep()
			}
		}
	}()
	return func() { close(stop) }
}
