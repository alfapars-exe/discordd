package services

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

type batchAppLogRepo struct {
	fakeAppLogRepo
	batchCalls    int
	block         bool
	blocked       chan struct{}
	signalBlocked sync.Once
}

type partialAppLogRepo struct {
	fakeAppLogRepo
	calls, failAt int
}

func (r *partialAppLogRepo) Insert(ctx context.Context, row *models.AppLog) error {
	r.calls++
	if r.calls == r.failAt {
		return errors.New("storage unavailable")
	}
	return r.fakeAppLogRepo.Insert(ctx, row)
}

func TestAppLogPartialFallbackCountsOnlyUnwrittenOccurrences(t *testing.T) {
	for _, tc := range []struct {
		failAt int
		lost   uint64
	}{{1, 6}, {2, 3}, {3, 1}, {4, 0}} {
		t.Run(fmt.Sprintf("fail-at-%d", tc.failAt), func(t *testing.T) {
			repo := &partialAppLogRepo{failAt: tc.failAt}
			service := NewAppLogService(repo, nil).(*appLogService)
			var pending []pendingAppLog
			for i, count := range []int{3, 2, 1} {
				for range count {
					pending = append(pending, pendingAppLog{entry: models.AppLog{Message: fmt.Sprintf("group-%d", i), Level: models.LogLevelError, OccurrenceCount: 1}, metadata: map[string]string{}})
				}
			}
			service.flush(context.Background(), pending)
			if got := service.Health().FailedEvents; got != tc.lost {
				t.Fatalf("failed events=%d, want only unwritten occurrences=%d", got, tc.lost)
			}
			var saved uint64
			for _, row := range repo.inserts {
				saved += uint64(row.OccurrenceCount)
			}
			if saved+tc.lost != uint64(len(pending)) {
				t.Fatalf("saved=%d lost=%d total=%d", saved, tc.lost, len(pending))
			}
			wantFailures := uint64(1)
			if tc.lost == 0 {
				wantFailures = 0
			}
			if got := service.Health().WriteFailures; got != wantFailures {
				t.Fatalf("write failures=%d, want=%d", got, wantFailures)
			}
		})
	}
}

func (r *batchAppLogRepo) InsertBatch(ctx context.Context, rows []models.AppLog) (int64, error) {
	if r.block {
		if r.blocked != nil {
			r.signalBlocked.Do(func() { close(r.blocked) })
		}
		<-ctx.Done()
		return 0, ctx.Err()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.batchCalls++
	r.inserts = append(r.inserts, rows...)
	return int64(len(rows)), nil
}

func TestAppLogPipelinePriorityGroupingAndOccurrenceTime(t *testing.T) {
	repo := &batchAppLogRepo{}
	svc := NewAppLogService(repo, repo).(*appLogService)
	for i := 0; i < cap(svc.ch); i++ {
		svc.Log(context.Background(), models.LogLevelInfo, models.LogCategoryClient, nil, nil, "telemetry", nil)
	}
	stamp := time.Now().Add(-time.Minute)
	for i := 0; i < 3; i++ {
		svc.enqueue(stamp.Add(time.Duration(i)*time.Millisecond), pkg.WithRequestID(context.Background(), "same-request"), models.LogLevelError, models.LogCategoryGeneral, nil, nil, "failure", map[string]string{"token": "NEVER_LOG", "nested": `{"password":"NEVER_LOG"}`})
	}
	svc.Log(pkg.WithRequestID(context.Background(), "different-request"), models.LogLevelError, models.LogCategoryGeneral, nil, nil, "failure", nil)
	svc.Start()
	svc.Stop()
	svc.Stop()
	repo.mu.Lock()
	defer repo.mu.Unlock()
	if len(repo.inserts) == 0 || repo.inserts[0].Level != models.LogLevelError {
		t.Fatalf("ERROR was not prioritized: %+v", repo.inserts)
	}
	var same, different *models.AppLog
	for i := range repo.inserts {
		e := &repo.inserts[i]
		if strings.Contains(e.Metadata, "NEVER_LOG") {
			t.Fatal("secret leaked")
		}
		if e.RequestID == "same-request" {
			same = e
		}
		if e.RequestID == "different-request" {
			different = e
		}
	}
	if same == nil || same.OccurrenceCount != 3 || different == nil || different.OccurrenceCount != 1 {
		t.Fatalf("grouping same=%+v different=%+v", same, different)
	}
	if same.CreatedAt != stamp.UTC().Format(time.RFC3339Nano) || same.LastSeenAt == same.CreatedAt {
		t.Fatalf("occurrence times lost: %+v", same)
	}
	if repo.batchCalls > 6 {
		t.Fatalf("unbatched writes: %d", repo.batchCalls)
	}
	if svc.Health().DroppedError != 0 || svc.Health().RetentionDays != 7 {
		t.Fatalf("health=%+v", svc.Health())
	}
}

func TestAppLogQueuesRemainBoundedAndErrorHasReservedCapacity(t *testing.T) {
	s := NewAppLogService(&fakeAppLogRepo{}, nil).(*appLogService)
	for i := 0; i < cap(s.ch)+10; i++ {
		s.Log(context.Background(), models.LogLevelInfo, models.LogCategoryClient, nil, nil, "info", nil)
	}
	s.Log(context.Background(), models.LogLevelError, models.LogCategoryGeneral, nil, nil, "important", nil)
	if s.Health().DroppedInfo != 10 || len(s.errors) != 1 || s.Health().DroppedError != 0 {
		t.Fatalf("health=%+v", s.Health())
	}
	for i := 0; i < cap(s.errors); i++ {
		s.Log(context.Background(), models.LogLevelError, models.LogCategoryGeneral, nil, nil, "error", nil)
	}
	if s.Health().DroppedError != 1 {
		t.Fatalf("health=%+v", s.Health())
	}
}

func TestAppLogFailedStorageDoesNotBlockEnqueueOrShutdown(t *testing.T) {
	r := &batchAppLogRepo{block: true}
	s := NewAppLogService(r, r).(*appLogService)
	start := time.Now()
	for i := 0; i < 64; i++ {
		s.Log(context.Background(), models.LogLevelError, models.LogCategoryGeneral, nil, nil, fmt.Sprint(i), nil)
	}
	if time.Since(start) > time.Second {
		t.Fatal("enqueue blocked on unavailable storage")
	}
	s.Start()
	start = time.Now()
	s.Stop()
	if time.Since(start) > 5500*time.Millisecond {
		t.Fatal("shutdown exceeded bounded drain")
	}
	if s.Health().WriteFailures == 0 || s.Health().FailedEvents == 0 {
		t.Fatalf("storage loss was hidden: %+v", s.Health())
	}
}

func TestAppLogConcurrentStopAndSizeLimit(t *testing.T) {
	r := &batchAppLogRepo{}
	s := NewAppLogService(r, r).(*appLogService)
	s.Start()
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 30; j++ {
				s.Log(context.Background(), models.LogLevelError, models.LogCategoryGeneral, nil, nil, strings.Repeat("x", 12000), map[string]string{"stack": strings.Repeat("\\\"", 8000)})
			}
		}()
	}
	wg.Wait()
	s.Stop()
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, row := range r.inserts {
		if len(row.Metadata)+len(row.Message)+512 > maxAppLogBytes {
			t.Fatal("oversized event")
		}
	}
}

func TestAppLogNoRetryOfFailedBatch(t *testing.T) {
	r := &batchAppLogRepo{block: true}
	s := NewAppLogService(r, r).(*appLogService)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	s.flush(ctx, []pendingAppLog{{entry: models.AppLog{Message: "fail", Level: models.LogLevelError, OccurrenceCount: 1}, metadata: map[string]string{}}})
	if !errors.Is(ctx.Err(), context.Canceled) || s.Health().WriteFailures != 1 {
		t.Fatal(s.Health())
	}
}

func BenchmarkAppLogEnqueue(b *testing.B) {
	s := NewAppLogService(&fakeAppLogRepo{}, nil).(*appLogService)
	ctx := pkg.WithRequestID(context.Background(), "benchmark-request")
	meta := map[string]string{"component": "http", "event_code": "HTTP_INTERNAL", "err": "connection unavailable"}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		s.Log(ctx, models.LogLevelError, models.LogCategoryGeneral, nil, nil, "server error", meta)
	}
}

func TestAppLogRequestLatencyUnderStorageFailure(t *testing.T) {
	for _, mode := range []string{"disabled", "healthy", "unavailable"} {
		t.Run(mode, func(t *testing.T) {
			repo := &batchAppLogRepo{block: mode == "unavailable"}
			svc := NewAppLogService(repo, repo).(*appLogService)
			if repo.block {
				repo.blocked = make(chan struct{})
			}
			if mode != "disabled" {
				svc.Start()
				defer svc.Stop()
			}
			if repo.block {
				for range appLogBatchSize {
					svc.Log(context.Background(), models.LogLevelError, models.LogCategoryGeneral, nil, nil, "prime writer", nil)
				}
				select {
				case <-repo.blocked:
				case <-time.After(5 * time.Second):
					t.Fatal("writer never reached blocked repository")
				}
			}
			ctx := pkg.WithRequestID(context.Background(), "load-request")
			req := httptest.NewRequest("POST", "/diagnostic", nil).WithContext(ctx)
			h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if mode != "disabled" {
					svc.Log(r.Context(), models.LogLevelError, models.LogCategoryGeneral, nil, nil, "load event", map[string]string{"event_code": "LOAD_TEST"})
				}
				w.WriteHeader(http.StatusNoContent)
			})
			latencies := make([]time.Duration, 2000)
			for i := range latencies {
				w := httptest.NewRecorder()
				start := time.Now()
				h.ServeHTTP(w, req)
				latencies[i] = time.Since(start)
			}
			sort.Slice(latencies, func(i, j int) bool { return latencies[i] < latencies[j] })
			p95 := latencies[len(latencies)*95/100]
			if p95 == 0 {
				t.Logf("request_p95 below host timer resolution; dropped_error=%d", svc.Health().DroppedError)
			} else {
				t.Logf("request_p95=%s dropped_error=%d", p95, svc.Health().DroppedError)
			}
			if mode == "unavailable" && p95 > 25*time.Millisecond {
				t.Fatalf("DB outage affected request latency: %s", p95)
			}
		})
	}
}

func TestAppLogExplicitSingleWriterDoesNotDiscoverBatchCapability(t *testing.T) {
	repo := &batchAppLogRepo{}
	service := NewAppLogService(repo, nil).(*appLogService)
	service.flush(context.Background(), []pendingAppLog{{entry: models.AppLog{Level: models.LogLevelError, Message: "single", OccurrenceCount: 1}, metadata: map[string]string{}}})
	if repo.batchCalls != 0 || len(repo.inserts) != 1 {
		t.Fatal("single writer rediscovered batch capability or lost row")
	}
}
