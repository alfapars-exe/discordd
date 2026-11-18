package services

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
)

func TestLinkPreviewStopJoinsCanceledWorker(t *testing.T) {
	entered, canceled, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	repo := &lpMockRepo{getByURLFn: func(ctx context.Context, _ string) (*models.LinkPreview, error) {
		close(entered)
		<-ctx.Done()
		close(canceled)
		<-release
		return nil, ctx.Err()
	}}
	s := NewLinkPreviewService(repo).(*linkPreviewService)
	requested := make(chan struct{})
	var requestErr error
	go func() {
		_, requestErr = s.GetPreview(context.Background(), "https://example.com/owned-flight")
		close(requested)
	}()
	var releaseOnce sync.Once
	var stoppers sync.WaitGroup
	t.Cleanup(func() { releaseOnce.Do(func() { close(release) }); s.Stop(); <-requested; stoppers.Wait() })
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("preview worker did not enter cache lookup")
	}
	stopped := make(chan struct{}, 2)
	stoppers.Add(2)
	for i := 0; i < 2; i++ {
		go func() { defer stoppers.Done(); s.Stop(); stopped <- struct{}{} }()
	}
	select {
	case <-canceled:
	case <-time.After(time.Second):
		t.Fatal("Stop did not cancel accepted worker")
	}
	if _, err := s.GetPreview(context.Background(), "https://example.com/after-stop"); !errors.Is(err, context.Canceled) {
		t.Fatalf("new preview admitted after Stop: %v", err)
	}
	select {
	case <-stopped:
		t.Fatal("Stop returned while canceled repository worker was still running")
	case <-time.After(25 * time.Millisecond):
	}
	releaseOnce.Do(func() { close(release) })
	for i := 0; i < 2; i++ {
		select {
		case <-stopped:
		case <-time.After(time.Second):
			t.Fatal("concurrent Stop did not join completed worker")
		}
	}
	select {
	case <-requested:
	case <-time.After(time.Second):
		t.Fatal("preview caller did not complete")
	}
	if requestErr == nil {
		t.Fatal("canceled preview unexpectedly succeeded")
	}
	s.Stop()
}
