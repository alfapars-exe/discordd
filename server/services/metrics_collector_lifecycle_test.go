package services

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
)

type lifecycleMetricsRepo struct {
	repository.LiveKitRepository
	list func(context.Context) ([]models.LiveKitInstance, error)
}

func (r *lifecycleMetricsRepo) ListPlatformInstances(ctx context.Context) ([]models.LiveKitInstance, error) {
	return r.list(ctx)
}

func lifecycleCollector(t *testing.T, list func(context.Context) ([]models.LiveKitInstance, error)) MetricsCollector {
	t.Helper()
	collector := NewMetricsCollector(&lifecycleMetricsRepo{list: list}, nil, time.Hour, 30, "", nil, nil)
	t.Cleanup(collector.Stop)
	return collector
}

func TestMetricsCollectorConcurrentStartRunsOneWorker(t *testing.T) {
	called := make(chan struct{}, 16)
	collector := lifecycleCollector(t, func(context.Context) ([]models.LiveKitInstance, error) { called <- struct{}{}; return nil, nil })
	var owners sync.WaitGroup
	owners.Add(16)
	for i := 0; i < 16; i++ {
		go func() { defer owners.Done(); collector.Start() }()
	}
	owners.Wait()
	select {
	case <-called:
	case <-time.After(time.Second):
		t.Fatal("initial collection did not run")
	}
	select {
	case <-called:
		t.Fatal("repeated Start launched another collector")
	case <-time.After(50 * time.Millisecond):
	}
}

func TestMetricsCollectorStopCancelsAndWaitsForActiveQuery(t *testing.T) {
	entered, cancelled, release, abort := make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	collector := lifecycleCollector(t, func(ctx context.Context) ([]models.LiveKitInstance, error) {
		close(entered)
		select {
		case <-ctx.Done():
			close(cancelled)
		case <-abort:
		}
		<-release
		return nil, ctx.Err()
	})
	t.Cleanup(func() { close(abort); releaseOnce.Do(func() { close(release) }) })
	collector.Start()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("query did not start")
	}
	stopped := make(chan struct{})
	go func() { collector.Stop(); close(stopped) }()
	select {
	case <-cancelled:
	case <-stopped:
		t.Fatal("Stop returned before cancelling active query")
	case <-time.After(time.Second):
		t.Fatal("Stop did not cancel active query")
	}
	select {
	case <-stopped:
		t.Fatal("Stop returned before active query exited")
	default:
	}
	releaseOnce.Do(func() { close(release) })
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("Stop did not wait for query completion")
	}
}

func TestMetricsCollectorConcurrentStopAndStopBeforeStart(t *testing.T) {
	var calls atomic.Int32
	collector := lifecycleCollector(t, func(context.Context) ([]models.LiveKitInstance, error) { calls.Add(1); return nil, nil })
	var owners sync.WaitGroup
	panics := make(chan any, 16)
	owners.Add(16)
	for i := 0; i < 16; i++ {
		go func() {
			defer owners.Done()
			defer func() {
				if value := recover(); value != nil {
					panics <- value
				}
			}()
			collector.Stop()
		}()
	}
	owners.Wait()
	close(panics)
	if len(panics) != 0 {
		t.Fatalf("concurrent Stop panicked %d times", len(panics))
	}
	collector.Start()
	time.Sleep(50 * time.Millisecond)
	if calls.Load() != 0 {
		t.Fatal("Start after shutdown launched a collector")
	}
}

type lifecycleMetricsHistory struct {
	repository.MetricsHistoryRepository
}

func (*lifecycleMetricsHistory) Insert(ctx context.Context, _ *models.MetricsSnapshot) error {
	return ctx.Err()
}
func (*lifecycleMetricsHistory) PurgeOlderThan(ctx context.Context, _ time.Time) (int64, error) {
	return 0, ctx.Err()
}

func TestMetricsCollectorStopCancelsRealHTTPPoll(t *testing.T) {
	entered, cancelled := make(chan struct{}), make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		close(entered)
		<-r.Context().Done()
		close(cancelled)
	}))
	t.Cleanup(func() { server.CloseClientConnections(); server.Close() })
	repo := &lifecycleMetricsRepo{list: func(context.Context) ([]models.LiveKitInstance, error) {
		return []models.LiveKitInstance{{ID: "instance", URL: server.URL}}, nil
	}}
	collector := NewMetricsCollector(repo, &lifecycleMetricsHistory{}, time.Hour, 30, "", nil, nil)
	t.Cleanup(collector.Stop)
	collector.Start()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("HTTP poll did not start")
	}
	stopped := make(chan struct{})
	go func() { collector.Stop(); close(stopped) }()
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("Stop did not cancel the real HTTP request")
	}
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("Stop did not finish after HTTP cancellation")
	}
}

func TestMetricsCollectorInterleavedLifecycleOwners(t *testing.T) {
	for wave := 0; wave < 25; wave++ {
		var calls atomic.Int32
		collector := lifecycleCollector(t, func(context.Context) ([]models.LiveKitInstance, error) { calls.Add(1); return nil, nil })
		var owners sync.WaitGroup
		owners.Add(16)
		for i := 0; i < 16; i++ {
			go func(start bool) {
				defer owners.Done()
				if start {
					collector.Start()
				} else {
					collector.Stop()
				}
			}(i%2 == 0)
		}
		owners.Wait()
		collector.Stop()
		if calls.Load() > 1 {
			t.Fatalf("wave %d collected %d times", wave, calls.Load())
		}
	}
}

type collectingMetricsHistory struct {
	repository.MetricsHistoryRepository
	snapshots chan models.MetricsSnapshot
	purges    atomic.Int32
}

func (r *collectingMetricsHistory) Insert(ctx context.Context, snapshot *models.MetricsSnapshot) error {
	select {
	case r.snapshots <- *snapshot:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (r *collectingMetricsHistory) PurgeOlderThan(ctx context.Context, _ time.Time) (int64, error) {
	r.purges.Add(1)
	return 0, ctx.Err()
}

func TestMetricsCollectorPreservesImmediateAndPeriodicSnapshots(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "livekit_room_total 2\nlivekit_participant_total 3\nprocess_resident_memory_bytes 1024\ngo_goroutines 4\n")
	}))
	t.Cleanup(server.Close)
	repo := &lifecycleMetricsRepo{list: func(context.Context) ([]models.LiveKitInstance, error) {
		return []models.LiveKitInstance{{ID: "instance", URL: server.URL}}, nil
	}}
	history := &collectingMetricsHistory{snapshots: make(chan models.MetricsSnapshot, 8)}
	collector := NewMetricsCollector(repo, history, time.Millisecond, 30, "", nil, nil)
	t.Cleanup(collector.Stop)
	collector.Start()
	for sample := 0; sample < 2; sample++ {
		select {
		case snapshot := <-history.snapshots:
			if snapshot.InstanceID != "instance" || snapshot.RoomCount != 2 || snapshot.ParticipantCount != 3 || snapshot.MemoryBytes != 1024 {
				t.Fatalf("sample %d changed: %+v", sample, snapshot)
			}
		case <-time.After(time.Second):
			t.Fatalf("sample %d was not collected", sample)
		}
	}
	collector.Stop()
	if history.purges.Load() == 0 {
		t.Fatal("periodic collection did not retain history cleanup")
	}
}
