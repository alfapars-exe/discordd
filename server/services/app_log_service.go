package services

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
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

const appLogRetentionDays = 7
const appLogBatchSize = 64
const maxAppLogBytes = 8 * 1024
const droppedReportInterval = time.Minute

type pendingAppLog struct {
	entry    models.AppLog
	metadata map[string]string
}
type appLogService struct {
	repo                                                        repository.AppLogRepository
	ch                                                          chan pendingAppLog
	errors                                                      chan pendingAppLog
	cancel                                                      context.CancelFunc
	done                                                        chan struct{}
	startOnce, stopOnce                                         sync.Once
	enqueueMu                                                   sync.RWMutex
	stopped                                                     bool
	dropped, droppedError, droppedWarn, droppedInfo             atomic.Uint64
	writeFailures, failedEvents, excludedDeleted, groupedEvents atomic.Uint64
	lastSuccess                                                 atomic.Int64
	stopDeadline                                                atomic.Int64
}

func NewAppLogService(repo repository.AppLogRepository) AppLogService {
	return &appLogService{repo: repo, ch: make(chan pendingAppLog, 256), errors: make(chan pendingAppLog, 512), done: make(chan struct{})}
}

func (s *appLogService) Log(ctx context.Context, level models.LogLevel, category models.LogCategory, userID, serverID *string, message string, metadata map[string]string) {
	s.enqueue(time.Now(), ctx, level, category, userID, serverID, message, metadata)
}
func (s *appLogService) enqueue(at time.Time, ctx context.Context, level models.LogLevel, category models.LogCategory, userID, serverID *string, message string, metadata map[string]string) {
	// Copy only bounded, sanitized values; JSON encoding and grouping are worker work.
	meta := make(map[string]string, min(len(metadata)+1, 64))
	keys := make([]string, 0, min(len(metadata), 64))
	for key := range metadata {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	budget := 4600
	for _, key := range keys {
		if len(meta) >= 48 || budget <= 0 {
			break
		}
		k := pkg.SafeLogString(key, 128)
		v := "***"
		if !pkg.IsSecretLogKey(key) {
			v = pkg.SafeLogString(metadata[key], min(2048, budget))
		}
		if len(k)+len(v) > budget {
			continue
		}
		meta[k] = v
		budget -= len(k) + len(v)
	}
	if id := pkg.RequestIDFrom(ctx); id != "" {
		meta["request_id"] = id
	}
	stamp := at.UTC().Format(time.RFC3339Nano)
	e := models.AppLog{Level: level, Category: category, UserID: copyLogID(userID), ServerID: copyLogID(serverID), Message: pkg.SafeLogString(message, 1024), CreatedAt: stamp, LastSeenAt: stamp, OccurrenceCount: 1,
		RequestID: pkg.SafeLogString(meta["request_id"], 128), EventCode: pkg.SafeLogString(meta["event_code"], 128), Component: pkg.SafeLogString(meta["component"], 128), ErrorKind: pkg.SafeLogString(meta["error_kind"], 64)}
	if e.EventCode == "" {
		e.EventCode = "APP_" + strings.ToUpper(string(level))
	}
	if e.ErrorKind == "" {
		if level == models.LogLevelError {
			e.ErrorKind = "internal"
		} else {
			e.ErrorKind = "operational"
		}
	}
	if e.Component == "" {
		e.Component = string(category)
	}
	s.enqueueMu.RLock()
	defer s.enqueueMu.RUnlock()
	if s.stopped {
		s.countDrop(level)
		return
	}
	queue := s.ch
	if level == models.LogLevelError {
		queue = s.errors
	}
	select {
	case queue <- pendingAppLog{entry: e, metadata: meta}:
	default:
		s.countDrop(level)
	}
}
func copyLogID(id *string) *string {
	if id == nil {
		return nil
	}
	v := pkg.SafeLogString(*id, 128)
	return &v
}
func (s *appLogService) countDrop(l models.LogLevel) {
	s.dropped.Add(1)
	switch l {
	case models.LogLevelError:
		s.droppedError.Add(1)
	case models.LogLevelWarn:
		s.droppedWarn.Add(1)
	default:
		s.droppedInfo.Add(1)
	}
}

// ConsumeRecord is the optional logx sink capability, not a new dependency from
// logx into services. AppLog-only producers remain supported without re-emission.
func (s *appLogService) ConsumeRecord(ctx context.Context, r slog.Record) {
	meta := map[string]string{}
	r.Attrs(func(a slog.Attr) bool { meta[a.Key] = fmt.Sprint(a.Value.Any()); return true })
	level := models.LogLevelWarn
	if r.Level >= slog.LevelError {
		level = models.LogLevelError
	}
	category := models.LogCategoryGeneral
	component := meta["component"]
	switch {
	case strings.Contains(component, "voice"), strings.Contains(component, "p2p"):
		category = models.LogCategoryVoice
	case strings.Contains(component, "auth"):
		category = models.LogCategoryAuth
	case strings.HasPrefix(component, "ws"):
		category = models.LogCategoryWS
	case strings.Contains(component, "livekit"):
		category = models.LogCategoryLiveKit
	}
	if c := meta["category"]; c != "" {
		category = models.LogCategory(c)
	}
	var userID, serverID *string
	if id := meta["user_id"]; id != "" {
		userID = &id
	}
	if id := meta["server_id"]; id != "" {
		serverID = &id
	}
	s.enqueue(r.Time, ctx, level, category, userID, serverID, r.Message, meta)
}
func (s *appLogService) Health() models.AppLogHealth {
	last := ""
	if n := s.lastSuccess.Load(); n > 0 {
		last = time.Unix(0, n).UTC().Format(time.RFC3339Nano)
	}
	return models.AppLogHealth{ErrorQueue: len(s.errors), NormalQueue: len(s.ch), ErrorCapacity: cap(s.errors), NormalCapacity: cap(s.ch), DroppedError: s.droppedError.Load(), DroppedWarn: s.droppedWarn.Load(), DroppedInfo: s.droppedInfo.Load(), WriteFailures: s.writeFailures.Load(), FailedEvents: s.failedEvents.Load(), ExcludedDeleted: s.excludedDeleted.Load(), GroupedEvents: s.groupedEvents.Load(), LastSuccessAt: last, RetentionDays: appLogRetentionDays}
}
func (s *appLogService) List(ctx context.Context, f models.AppLogFilter) ([]models.AppLog, int, error) {
	cutoff := time.Now().AddDate(0, 0, -appLogRetentionDays).UTC()
	if requested, err := time.Parse(time.RFC3339Nano, f.From); err != nil || requested.Before(cutoff) {
		f.From = cutoff.Format(time.RFC3339Nano)
	}
	return s.repo.List(ctx, f)
}
func (s *appLogService) Clear(ctx context.Context) error { return s.repo.DeleteAll(ctx) }
func (s *appLogService) Start() {
	s.startOnce.Do(func() {
		ctx, cancel := context.WithCancel(context.Background())
		s.cancel = cancel
		logx.Go("app_log.writer", func() { s.writerLoop(ctx) })
	})
}
func (s *appLogService) Stop() {
	s.Start()
	s.stopOnce.Do(func() {
		s.enqueueMu.Lock()
		s.stopped = true
		s.stopDeadline.Store(time.Now().Add(5 * time.Second).UnixNano())
		s.enqueueMu.Unlock()
		s.cancel()
	})
	<-s.done
}

func (s *appLogService) writerLoop(ctx context.Context) {
	defer close(s.done)
	batch := make([]pendingAppLog, 0, appLogBatchSize)
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	purge := time.NewTicker(time.Hour)
	defer purge.Stop()
	watchdog := time.NewTicker(droppedReportInterval)
	defer watchdog.Stop()
	// Purge uses the same single worker: never adds a competing DB writer.
	s.purge(ctx)
	for {
		// Always choose a queued ERROR before normal telemetry; each completed batch
		// still has a hard bound, so neither memory nor writer work grows unbounded.
		var entry pendingAppLog
		have := false
		select {
		case <-ctx.Done():
			s.drain(batch)
			return
		default:
		}
		select {
		case entry = <-s.errors:
			have = true
		default:
		}
		if !have {
			select {
			case <-ctx.Done():
				s.drain(batch)
				return
			case entry = <-s.errors:
				have = true
			case entry = <-s.ch:
				have = true
			case <-ticker.C:
				if len(batch) > 0 {
					s.flush(context.Background(), batch)
					batch = batch[:0]
				}
			case <-purge.C:
				s.purge(ctx)
			case <-watchdog.C:
				if n := s.dropped.Swap(0); n > 0 {
					appLogger.Warn("app log entries dropped", "count", n)
				}
			}
		}
		if have {
			batch = append(batch, entry)
			if len(batch) >= appLogBatchSize {
				s.flush(context.Background(), batch)
				batch = batch[:0]
			}
		}
	}
}
func (s *appLogService) flush(parent context.Context, pending []pendingAppLog) {
	if len(pending) == 0 {
		return
	}
	rows := make([]models.AppLog, 0, len(pending))
	keys := make(map[string]int, len(pending))
	for _, p := range pending {
		b, err := json.Marshal(p.metadata)
		if err != nil {
			b = []byte("{}")
		}
		p.entry.Metadata = string(b)
		// Enforce serialized byte size too (JSON escaping can expand strings).
		for len(p.entry.Metadata)+len(p.entry.Message)+len(p.entry.Component)+len(p.entry.EventCode)+len(p.entry.ErrorKind)+len(p.entry.RequestID)+512 > maxAppLogBytes && len(p.metadata) > 0 {
			longest := ""
			for k, v := range p.metadata {
				if len(k)+len(v) > len(longest)+len(p.metadata[longest]) {
					longest = k
				}
			}
			delete(p.metadata, longest)
			b, _ = json.Marshal(p.metadata)
			p.entry.Metadata = string(b)
		}
		keyBytes, _ := json.Marshal([]any{p.entry.Level, p.entry.Category, p.entry.UserID, p.entry.ServerID, p.entry.Message, p.entry.Metadata, p.entry.RequestID, p.entry.EventCode, p.entry.Component, p.entry.ErrorKind})
		key := string(keyBytes)
		if i, ok := keys[key]; ok {
			rows[i].OccurrenceCount++
			if p.entry.LastSeenAt > rows[i].LastSeenAt {
				rows[i].LastSeenAt = p.entry.LastSeenAt
			}
			if p.entry.CreatedAt < rows[i].CreatedAt {
				rows[i].CreatedAt = p.entry.CreatedAt
			}
			s.groupedEvents.Add(1)
		} else {
			keys[key] = len(rows)
			rows = append(rows, p.entry)
		}
	}
	ctx, cancel := context.WithTimeout(parent, 2*time.Second)
	defer cancel()
	var err error
	var written int64
	if batch, ok := s.repo.(interface {
		InsertBatch(context.Context, []models.AppLog) (int64, error)
	}); ok {
		written, err = batch.InsertBatch(ctx, rows)
	} else {
		for i := range rows {
			if err = s.repo.Insert(ctx, &rows[i]); err != nil {
				break
			}
			written++
		}
	}
	if err != nil {
		s.writeFailures.Add(1)
		s.failedEvents.Add(uint64(len(pending)))
		appLogger.Error("failed to write log batch", "count", len(rows), "err", pkg.ErrText(err))
		return
	}
	if written >= 0 && written < int64(len(rows)) {
		s.excludedDeleted.Add(uint64(len(rows)) - uint64(written))
	}
	s.lastSuccess.Store(time.Now().UnixNano())
}
func (s *appLogService) purge(parent context.Context) {
	ctx, cancel := context.WithTimeout(parent, 2*time.Second)
	defer cancel()
	cutoff := time.Now().AddDate(0, 0, -appLogRetentionDays).UTC().Format("2006-01-02 15:04:05")
	for ctx.Err() == nil {
		n, err := s.repo.DeleteBefore(ctx, cutoff)
		if err != nil {
			if parent.Err() == nil {
				appLogger.Warn("app log purge failed", "err", pkg.ErrText(err))
			}
			return
		}
		if n < 1000 {
			return
		}
	}
}
func (s *appLogService) drain(batch []pendingAppLog) {
	deadline := time.Now().Add(5 * time.Second)
	if n := s.stopDeadline.Load(); n > 0 {
		deadline = time.Unix(0, n)
	}
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()
	for {
		if ctx.Err() != nil {
			for _, p := range batch {
				s.countDrop(p.entry.Level)
			}
			s.dropQueued()
			return
		}
		if len(batch) >= appLogBatchSize {
			s.flush(ctx, batch)
			batch = batch[:0]
		}
		select {
		case e := <-s.errors:
			batch = append(batch, e)
			continue
		default:
		}
		select {
		case e := <-s.ch:
			batch = append(batch, e)
		default:
			s.flush(ctx, batch)
			return
		}
	}
}
func (s *appLogService) dropQueued() {
	for {
		select {
		case e := <-s.errors:
			s.countDrop(e.entry.Level)
		case e := <-s.ch:
			s.countDrop(e.entry.Level)
		default:
			return
		}
	}
}
