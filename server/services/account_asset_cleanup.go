package services

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/repository"
)

type AccountAssetCleanup struct {
	repo      repository.AccountAssetCleanupRepository
	uploadDir string
	mu        sync.Mutex
	status    AccountAssetCleanupStatus
	cancel    context.CancelFunc
	done      chan struct{}
}

type AccountAssetCleanupStatus struct {
	Running             bool               `json:"running"`
	LastCheckedAt       *time.Time         `json:"last_checked_at"`
	LastSuccessAt       *time.Time         `json:"last_success_at"`
	ConsecutiveFailures int                `json:"consecutive_failures"`
	Result              AssetCleanupResult `json:"last_result"`
}

func (s *AccountAssetCleanup) Status() AccountAssetCleanupStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status
}
func (s *AccountAssetCleanup) Start(ctx context.Context) func() { return s.start(ctx, time.Minute) }
func (s *AccountAssetCleanup) start(parent context.Context, interval time.Duration) func() {
	s.mu.Lock()
	if s.cancel != nil {
		cancel, done := s.cancel, s.done
		s.mu.Unlock()
		return func() { cancel(); <-done }
	}
	ctx, cancel := context.WithCancel(parent)
	done := make(chan struct{})
	s.cancel = cancel
	s.done = done
	s.status.Running = true
	s.status.LastCheckedAt = nil
	s.mu.Unlock()
	logx.Go("account_asset_cleanup", func() {
		defer func() { s.mu.Lock(); s.status.Running = false; s.cancel = nil; close(done); s.mu.Unlock() }()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			if ctx.Err() != nil {
				return
			}
			bounded, release := context.WithTimeout(ctx, 30*time.Second)
			result, err := s.RunOnce(bounded, time.Now())
			release()
			if ctx.Err() != nil {
				return
			}
			now := time.Now()
			s.mu.Lock()
			s.status.LastCheckedAt = &now
			s.status.Result = result
			if err != nil || result.Retry > 0 {
				s.status.ConsecutiveFailures++
			} else {
				s.status.ConsecutiveFailures = 0
				s.status.LastSuccessAt = &now
			}
			s.mu.Unlock()
			if err != nil || result.Retry > 0 {
				logx.Component("account_asset_cleanup").Warn("personal asset cleanup incomplete; durable retry remains", "retry_count", result.Retry, "database_or_root_error", err != nil)
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	})
	return func() { cancel(); <-done }
}

type AssetCleanupResult struct{ Removed, Referenced, Retry, Skipped int }

func NewAccountAssetCleanup(repo repository.AccountAssetCleanupRepository, uploadDir string) *AccountAssetCleanup {
	return &AccountAssetCleanup{repo: repo, uploadDir: uploadDir}
}

// RunOnce is intentionally bounded. No directory sweep or recursive deletion.
// The production scheduler reports only aggregate health, never queued paths.
func (s *AccountAssetCleanup) RunOnce(ctx context.Context, now time.Time) (result AssetCleanupResult, runErr error) {
	if s.uploadDir == "" {
		return result, fmt.Errorf("upload cleanup is not configured")
	}
	info, err := os.Lstat(s.uploadDir)
	if err != nil {
		return result, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return result, fmt.Errorf("upload root must be a real directory")
	}
	root, err := os.OpenRoot(s.uploadDir)
	if err != nil {
		return result, err
	}
	defer func() {
		if closeErr := root.Close(); closeErr != nil {
			runErr = errors.Join(runErr, fmt.Errorf("close upload root: %w", closeErr))
		}
	}()
	urls, err := s.repo.Due(ctx, now.Unix(), 25)
	if err != nil {
		return result, err
	}
	for _, url := range urls {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		outcome, err := s.repo.Process(ctx, url, now.Unix(), func() error { return removeAccountAsset(root, url) })
		if err != nil {
			return result, err
		}
		switch outcome {
		case "removed":
			result.Removed++
		case "referenced":
			result.Referenced++
		case "retry":
			result.Retry++
		default:
			result.Skipped++
		}
	}
	return result, nil
}
func removeAccountAsset(root *os.Root, url string) error {
	const prefix = "/api/uploads/"
	if !strings.HasPrefix(url, prefix) {
		return fmt.Errorf("not a local upload URL")
	}
	rel := strings.TrimPrefix(url, prefix)
	// URLs must already be canonical. Reject percent decoding, queries, ADS,
	// Windows separators and dot segments rather than normalizing aliases.
	if rel == "" || strings.ContainsAny(rel, "%?#:\\\x00") || path.Clean(rel) != rel || strings.HasPrefix(rel, "/") || rel == "." || rel == ".." || strings.HasPrefix(rel, "../") {
		return fmt.Errorf("noncanonical upload URL")
	}
	for _, part := range strings.Split(rel, "/") {
		if part == "" || strings.TrimRight(part, " .") != part {
			return fmt.Errorf("ambiguous upload component")
		}
	}
	// os.Root confines all operations even if a parent is swapped while this
	// runs. Refuse symlinks explicitly; Remove never follows a final symlink.
	parts := strings.Split(rel, "/")
	for i := range parts {
		info, err := root.Lstat(strings.Join(parts[:i+1], "/"))
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("symbolic upload path")
		}
		if i == len(parts)-1 && !info.Mode().IsRegular() {
			return fmt.Errorf("upload is not a regular file")
		}
	}
	if err := root.Remove(rel); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}
