package services

import (
	"context"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/testutil"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type uploadCleanupLookup struct {
	testutil.MockDMRepo
	lookup func(context.Context, string) (*models.DMAttachment, error)
}

func (r *uploadCleanupLookup) GetAttachmentByFileURL(ctx context.Context, url string) (*models.DMAttachment, error) {
	return r.lookup(ctx, url)
}

func TestDMUploadRuntimeStopJoinsInFlightCleanup(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "dmstage_0123456789abcdef_owned.bin")
	if err := os.WriteFile(path, []byte("staged"), 0600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-48 * time.Hour)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
	started, cancelled, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	repo := &uploadCleanupLookup{}
	repo.lookup = func(ctx context.Context, url string) (*models.DMAttachment, error) {
		close(started)
		<-ctx.Done()
		close(cancelled)
		<-release
		return nil, ctx.Err()
	}
	runtime := NewDMUploadService(repo, dir, 1024)
	stop := runtime.StartDMUploadCleanup(context.Background())
	select {
	case <-started:
	case <-time.After(time.Second):
		close(release)
		stop()
		t.Fatal("cleanup did not start")
	}
	stopped := make(chan struct{})
	go func() { stop(); close(stopped) }()
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		close(release)
		t.Fatal("stop did not cancel repository operation")
	}
	select {
	case <-stopped:
		close(release)
		t.Fatal("stop returned before in-flight lookup finished")
	default:
	}
	close(release)
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("stop did not join worker")
	}
	stop()
	if _, err := os.Stat(path); err != nil {
		t.Fatal("cancelled lookup removed staged bytes", err)
	}
}
