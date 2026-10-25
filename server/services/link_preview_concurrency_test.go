package services

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
)

type concurrentPreviewRepo struct {
	mu     sync.Mutex
	cached *models.LinkPreview
	writes int
}

func (r *concurrentPreviewRepo) GetByURL(context.Context, string) (*models.LinkPreview, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.cached, nil
}
func (r *concurrentPreviewRepo) Upsert(_ context.Context, p *models.LinkPreview) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	copy := *p
	copy.FetchedAt = time.Now().UTC().Format(time.RFC3339Nano)
	r.cached = &copy
	r.writes++
	return nil
}
func (r *concurrentPreviewRepo) DeleteExpired(context.Context, time.Time) (int64, error) {
	return 0, nil
}

func TestPreviewCacheAcceptsPostgresAndSQLiteDates(t *testing.T) {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02 15:04:05"} {
		t.Run(layout, func(t *testing.T) {
			for _, negative := range []bool{false, true} {
				r := &concurrentPreviewRepo{cached: &models.LinkPreview{FetchedAt: time.Now().Add(-10 * time.Second).UTC().Format(layout), Error: negative}}
				s := newLinkPreviewServiceForTest(r, nil, "")
				defer s.Stop()
				_, err := s.GetPreview(context.Background(), "https://youtube.com/watch?v=x")
				if negative {
					status, code, _ := LinkPreviewFailureInfo(err)
					if status != 502 || code != "PREVIEW_CACHED_FAILURE" {
						t.Fatalf("err=%v", err)
					}
				} else if err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}

func TestPreviewSharesFetchAndOneCanceledWaiterDoesNotCancelOthers(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			close(started)
		}
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"title":"shared"}`))
	}))
	defer ts.Close()
	repo := &concurrentPreviewRepo{}
	s := newLinkPreviewServiceForTest(repo, ts.Client(), ts.URL)
	defer s.Stop()
	ctx, cancel := context.WithCancel(context.Background())
	first := make(chan error, 1)
	go func() { _, err := s.GetPreview(ctx, "https://youtube.com/watch?v=shared"); first <- err }()
	<-started
	second := make(chan error, 1)
	go func() {
		_, err := s.GetPreview(context.Background(), "https://youtube.com/watch?v=shared")
		second <- err
	}()
	deadline := time.Now().Add(time.Second)
	for {
		s.mu.Lock()
		waiters := 0
		for _, f := range s.pending {
			waiters = f.waiters
		}
		s.mu.Unlock()
		if waiters == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("second caller did not join")
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	if err := <-first; !errors.Is(err, context.Canceled) {
		t.Fatalf("first err=%v", err)
	}
	close(release)
	if err := <-second; err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatalf("fetches=%d", calls.Load())
	}
}

func TestPreviewAllCanceledDoesNotCacheFailure(t *testing.T) {
	started := make(chan struct{})
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(started); <-r.Context().Done() }))
	defer ts.Close()
	r := &concurrentPreviewRepo{}
	s := newLinkPreviewServiceForTest(r, ts.Client(), ts.URL)
	defer s.Stop()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := s.GetPreview(ctx, "https://youtube.com/watch?v=cancel"); done <- err }()
	<-started
	cancel()
	<-done
	deadline := time.Now().Add(time.Second)
	for {
		s.mu.Lock()
		n := len(s.pending)
		s.mu.Unlock()
		if n == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("canceled fetch leaked")
		}
		time.Sleep(time.Millisecond)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.writes != 0 {
		t.Fatal("cancellation was negative cached")
	}
}

func TestPreviewConcurrencyLimitAndNegativeExpiry(t *testing.T) {
	var active, maximum atomic.Int32
	release := make(chan struct{})
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := active.Add(1)
		defer active.Add(-1)
		for {
			old := maximum.Load()
			if n <= old || maximum.CompareAndSwap(old, n) {
				break
			}
		}
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		_, _ = w.Write([]byte(`{"title":"bounded"}`))
	}))
	defer ts.Close()
	r := &concurrentPreviewRepo{}
	s := newLinkPreviewServiceForTest(r, ts.Client(), ts.URL)
	defer s.Stop()
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			_, _ = s.GetPreview(context.Background(), "https://youtube.com/watch?v="+string(rune('a'+id)))
		}(i)
	}
	deadline := time.Now().Add(time.Second)
	for active.Load() < 4 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if active.Load() != 4 {
		t.Fatalf("active=%d", active.Load())
	}
	close(release)
	wg.Wait()
	if maximum.Load() > 4 {
		t.Fatalf("max=%d", maximum.Load())
	}
	r.mu.Lock()
	r.cached = &models.LinkPreview{Error: true, FetchedAt: time.Now().Add(-2 * time.Minute).UTC().Format(time.RFC3339Nano)}
	r.mu.Unlock()
	if _, err := s.GetPreview(context.Background(), "https://youtube.com/watch?v=retry"); err != nil {
		t.Fatalf("negative cache did not expire: %v", err)
	}
}
