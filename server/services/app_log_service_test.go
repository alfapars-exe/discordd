// app_log_service_test.go — covers the buffer-drop counter (2d hardening):
// Log()'s non-blocking send must count a drop instead of losing it silently,
// and the writer goroutine (now wrapped by logx.Go) must still behave
// normally end-to-end.
package services

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

// fakeAppLogRepo is a minimal repository.AppLogRepository fake. mu guards
// inserts since Insert is called from the service's async writer goroutine
// while the test goroutine reads back via count()/snapshot().
type fakeAppLogRepo struct {
	mu      sync.Mutex
	inserts []models.AppLog
}

func (f *fakeAppLogRepo) Insert(_ context.Context, log *models.AppLog) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.inserts = append(f.inserts, *log)
	return nil
}

func (f *fakeAppLogRepo) List(_ context.Context, _ models.AppLogFilter) ([]models.AppLog, int, error) {
	return nil, 0, nil
}

func (f *fakeAppLogRepo) DeleteBefore(_ context.Context, _ string) (int64, error) {
	return 0, nil
}

func (f *fakeAppLogRepo) DeleteAll(_ context.Context) error {
	return nil
}

func (f *fakeAppLogRepo) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.inserts)
}

// TestAppLogService_Log_countsDroppedWhenChannelFull fills the buffered
// channel to capacity without starting the writer goroutine (so nothing
// drains it), then verifies further Log() calls hit the default/drop branch
// and increment the dropped counter instead of blocking or panicking.
func TestAppLogService_Log_countsDroppedWhenChannelFull(t *testing.T) {
	repo := &fakeAppLogRepo{}
	svc := NewAppLogService(repo).(*appLogService)

	capacity := cap(svc.ch)
	for i := 0; i < capacity; i++ {
		svc.Log(context.Background(), models.LogLevelInfo, models.LogCategoryWS, nil, nil, "fill", nil)
	}
	if got := svc.dropped.Load(); got != 0 {
		t.Fatalf("dropped = %d after filling to capacity (not overflowing), want 0", got)
	}

	const overflow = 10
	for i := 0; i < overflow; i++ {
		svc.Log(context.Background(), models.LogLevelInfo, models.LogCategoryWS, nil, nil, "overflow", nil)
	}
	if got := svc.dropped.Load(); got != uint64(overflow) {
		t.Errorf("dropped = %d, want %d", got, overflow)
	}
}

// TestAppLogService_droppedCounter_swapResetsToZero verifies the exact
// atomic operation the dropped-watchdog goroutine performs: Swap(0) returns
// the accumulated count and leaves the counter at zero for the next window.
func TestAppLogService_droppedCounter_swapResetsToZero(t *testing.T) {
	repo := &fakeAppLogRepo{}
	svc := NewAppLogService(repo).(*appLogService)

	svc.dropped.Add(3)
	svc.dropped.Add(4)

	if got := svc.dropped.Swap(0); got != 7 {
		t.Fatalf("Swap(0) = %d, want 7", got)
	}
	if got := svc.dropped.Load(); got != 0 {
		t.Errorf("counter after Swap(0) = %d, want 0", got)
	}
}

// TestAppLogService_Log_StampsRequestIDFromContext — P3.8: when ctx carries
// a request id, it must land in the persisted row's metadata under
// "request_id" without mutating the caller's own metadata map (the caller
// may reuse or re-read it after the call).
func TestAppLogService_Log_StampsRequestIDFromContext(t *testing.T) {
	repo := &fakeAppLogRepo{}
	svc := NewAppLogService(repo).(*appLogService)
	svc.Start()
	defer svc.Stop()

	ctx := pkg.WithRequestID(context.Background(), "req-abc123")
	callerMeta := map[string]string{"foo": "bar"}
	svc.Log(ctx, models.LogLevelInfo, models.LogCategoryWS, nil, nil, "with request id", callerMeta)

	deadline := time.Now().Add(2 * time.Second)
	for repo.count() < 1 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if repo.count() != 1 {
		t.Fatalf("repo received %d entries, want 1", repo.count())
	}

	repo.mu.Lock()
	got := repo.inserts[0].Metadata
	repo.mu.Unlock()

	var meta map[string]string
	if err := json.Unmarshal([]byte(got), &meta); err != nil {
		t.Fatalf("unmarshal metadata %q: %v", got, err)
	}
	if meta["request_id"] != "req-abc123" {
		t.Errorf("metadata[request_id] = %q, want req-abc123 (full metadata: %v)", meta["request_id"], meta)
	}
	if meta["foo"] != "bar" {
		t.Errorf("caller's own metadata key was lost: %v", meta)
	}

	if _, mutated := callerMeta["request_id"]; mutated {
		t.Error("Log must not mutate the caller's metadata map in place")
	}
	if len(callerMeta) != 1 {
		t.Errorf("caller's metadata map was mutated: %v", callerMeta)
	}
}

// TestAppLogService_Log_NoRequestIDInContext_NilMetadataStaysNil — the
// common background-goroutine case (context.Background(), no metadata):
// Log must not panic or synthesize an empty metadata map when there's
// nothing to add.
func TestAppLogService_Log_NoRequestIDInContext_NilMetadataStaysNil(t *testing.T) {
	repo := &fakeAppLogRepo{}
	svc := NewAppLogService(repo).(*appLogService)
	svc.Start()
	defer svc.Stop()

	svc.Log(context.Background(), models.LogLevelInfo, models.LogCategoryWS, nil, nil, "no request id", nil)

	deadline := time.Now().Add(2 * time.Second)
	for repo.count() < 1 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if repo.count() != 1 {
		t.Fatalf("repo received %d entries, want 1", repo.count())
	}

	repo.mu.Lock()
	got := repo.inserts[0].Metadata
	repo.mu.Unlock()
	if got != "{}" {
		t.Errorf("metadata = %q, want the empty-object sentinel {}", got)
	}
}

// TestAppLogService_Start_writesEntriesAndStopsCleanly is a sanity check
// that wrapping the writer goroutine with logx.Go didn't change its
// observable behavior: entries pushed via Log() still reach the repo, and
// Stop() still returns (proving close(s.done) still fires).
func TestAppLogService_Start_writesEntriesAndStopsCleanly(t *testing.T) {
	repo := &fakeAppLogRepo{}
	svc := NewAppLogService(repo).(*appLogService)
	svc.Start()

	svc.Log(context.Background(), models.LogLevelInfo, models.LogCategoryWS, nil, nil, "hello", nil)

	deadline := time.Now().Add(2 * time.Second)
	for repo.count() < 1 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if repo.count() != 1 {
		t.Fatalf("repo received %d entries, want 1", repo.count())
	}

	stopped := make(chan struct{})
	go func() {
		svc.Stop()
		close(stopped)
	}()
	select {
	case <-stopped:
	case <-time.After(2 * time.Second):
		t.Fatal("Stop() did not return — writer goroutine may not have exited")
	}
}
