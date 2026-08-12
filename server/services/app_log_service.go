package services

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/repository"
)

var appLogger = logx.Component("service.applog")

// AppLogService writes and queries structured app logs.
type AppLogService interface {
	// Log writes a log entry asynchronously (non-blocking). ctx is used only
	// to pull the request's correlation id (pkg.RequestIDFrom) into
	// metadata["request_id"] when present — pass context.Background() from a
	// background goroutine that has no request context.
	Log(ctx context.Context, level models.LogLevel, category models.LogCategory, userID, serverID *string, message string, metadata map[string]string)
	// List returns paginated, filtered log entries.
	List(ctx context.Context, filter models.AppLogFilter) ([]models.AppLog, int, error)
	// Clear deletes all logs.
	Clear(ctx context.Context) error
	// Start begins the async writer goroutine and auto-purge ticker.
	Start()
	// Stop signals goroutines to exit and drains buffered entries.
	Stop()
}

type appLogService struct {
	repo   repository.AppLogRepository
	ch     chan models.AppLog
	cancel context.CancelFunc
	done   chan struct{}

	// dropped counts entries discarded because ch was full (Log's
	// non-blocking send hit its default case). Incremented on the caller's
	// goroutine, drained and reported by the watchdog goroutine in Start —
	// otherwise buffer overload during a traffic spike silently loses log
	// entries with no operational signal.
	dropped atomic.Uint64
}

// NewAppLogService creates the service. Call Start() to begin async writing.
func NewAppLogService(repo repository.AppLogRepository) AppLogService {
	return &appLogService{
		repo: repo,
		ch:   make(chan models.AppLog, 256),
		done: make(chan struct{}),
	}
}

func (s *appLogService) Log(ctx context.Context, level models.LogLevel, category models.LogCategory, userID, serverID *string, message string, metadata map[string]string) {
	// Stamp the request's correlation id when one is present, so an app_logs
	// row can be matched back to the request that produced it the same way
	// an API error response's correlation_id already can (pkg.ErrorCtx).
	// Copy rather than mutate: metadata is the caller's map (often reused or
	// read again after this call), and it may be nil.
	if reqID := pkg.RequestIDFrom(ctx); reqID != "" {
		withReqID := make(map[string]string, len(metadata)+1)
		for k, v := range metadata {
			withReqID[k] = v
		}
		withReqID["request_id"] = reqID
		metadata = withReqID
	}

	metaJSON := "{}"
	if metadata != nil {
		if b, err := json.Marshal(metadata); err == nil {
			metaJSON = string(b)
		}
	}

	entry := models.AppLog{
		Level:    level,
		Category: category,
		UserID:   userID,
		ServerID: serverID,
		Message:  message,
		Metadata: metaJSON,
	}

	// Non-blocking send — drop if buffer full (prevents backpressure on hot
	// paths). Just counts the drop instead of logging one line per entry:
	// under sustained overload that would itself flood the log. The
	// dropped-watchdog goroutine in Start reports the total periodically.
	select {
	case s.ch <- entry:
	default:
		s.dropped.Add(1)
	}
}

func (s *appLogService) List(ctx context.Context, filter models.AppLogFilter) ([]models.AppLog, int, error) {
	return s.repo.List(ctx, filter)
}

func (s *appLogService) Clear(ctx context.Context) error {
	return s.repo.DeleteAll(ctx)
}

// droppedReportInterval controls how often the dropped-watchdog goroutine
// checks and reports Log() entries discarded due to a full buffer.
const droppedReportInterval = time.Minute

// Start runs the async writer, the dropped-entry watchdog, and the daily
// auto-purge (30 days). Each background goroutine is wrapped with logx.Go:
// an unrecovered panic in any one of them would otherwise crash the whole
// process, not just app logging.
func (s *appLogService) Start() {
	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel

	logx.Go("app_log.writer", func() { s.writerLoop(ctx) })
	logx.Go("app_log.dropped_watchdog", func() { s.droppedWatchdogLoop(ctx) })
	logx.Go("app_log.auto_purge", func() { s.autoPurgeLoop(ctx) })
}

// writerLoop drains s.ch and writes each entry to the DB until ctx is
// canceled, then drains whatever is left buffered. Split out of Start purely
// to keep each goroutine's branching separately readable; behavior unchanged.
func (s *appLogService) writerLoop(ctx context.Context) {
	defer close(s.done)
	for {
		select {
		case <-ctx.Done():
			s.drain()
			return
		case entry := <-s.ch:
			if err := s.repo.Insert(ctx, &entry); err != nil {
				appLogger.Error("failed to write log entry", "err", pkg.ErrText(err))
			}
		}
	}
}

// droppedWatchdogLoop periodically surfaces how many Log() calls were
// discarded because the buffer was full since the last report, so overload
// becomes visible (a WARN in the log / Sentry breadcrumb) instead of
// silently losing diagnostic data.
func (s *appLogService) droppedWatchdogLoop(ctx context.Context) {
	ticker := time.NewTicker(droppedReportInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if n := s.dropped.Swap(0); n > 0 {
				slog.Warn("app_log dropped entries", "count", n)
			}
		}
	}
}

// autoPurgeLoop deletes logs older than 30 days, checking every 6 hours.
func (s *appLogService) autoPurgeLoop(ctx context.Context) {
	ticker := time.NewTicker(6 * time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			cutoff := time.Now().AddDate(0, 0, -30).UTC().Format("2006-01-02 15:04:05")
			deleted, err := s.repo.DeleteBefore(ctx, cutoff)
			if err != nil {
				appLogger.Error("auto-purge failed", "err", pkg.ErrText(err))
			} else if deleted > 0 {
				appLogger.Info("auto-purge deleted old logs", "count", deleted, "max_age_days", 30)
			}
		}
	}
}

// Stop cancels background goroutines and drains any buffered log entries.
func (s *appLogService) Stop() {
	if s.cancel != nil {
		s.cancel()
	}
	<-s.done
	appLogger.Info("app log service stopped")
}

// drain flushes remaining entries from the channel before exit.
func (s *appLogService) drain() {
	for {
		select {
		case entry := <-s.ch:
			if err := s.repo.Insert(context.Background(), &entry); err != nil {
				appLogger.Error("drain: failed to write log entry", "err", pkg.ErrText(err))
			}
		default:
			return
		}
	}
}
