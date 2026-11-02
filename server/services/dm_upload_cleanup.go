package services

import (
	"context"
	"errors"
	"io"
	"os"
	"regexp"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

var dmStageName = regexp.MustCompile(`^dmstage_[a-f0-9]{16}_`)

// Only the singleton backend owner scans newly staged DM files. Fresh files and
// every file with a committed attachment reference survive, including lost ACKs.
func StartDMUploadCleanup(parent context.Context, service DMUploadService) func() {
	s, ok := service.(*dmUploadService)
	if !ok {
		return func() { /* Optional upload adapters own no maintenance resources. */ }
	}
	ctx, cancel := context.WithCancel(parent) // NOSONAR: ownership transfers to worker defer and returned stop; deferring here would stop the worker immediately.
	done := make(chan struct{})
	go func() {
		defer cancel() // The worker also releases its derived context on exit.
		defer close(done)
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		for {
			operation, stop := context.WithTimeout(ctx, 30*time.Second)
			if err := s.cleanupStagedUploads(operation, time.Now().Add(-24*time.Hour)); err != nil && !errors.Is(err, context.Canceled) {
				dmLogger.Error("DM staging cleanup failed")
			}
			stop()
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	return func() { cancel(); <-done }
}

func (s *dmUploadService) cleanupStagedUploads(ctx context.Context, before time.Time) error {
	directory, err := os.Open(s.uploadDir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer directory.Close()
	for {
		entries, readErr := directory.ReadDir(64)
		for _, entry := range entries {
			if err := s.cleanupStagedEntry(ctx, entry, before); err != nil {
				return err
			}
		}

		if errors.Is(readErr, io.EOF) {
			return nil
		}
		if readErr != nil {
			return readErr
		}
	}
}

func (s *dmUploadService) cleanupStagedEntry(ctx context.Context, entry os.DirEntry, before time.Time) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !dmStageName.MatchString(entry.Name()) || entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
		return nil
	}
	info, err := entry.Info()
	if err != nil {
		return err
	}
	if !info.ModTime().Before(before) {
		return nil
	}
	url := "/api/uploads/" + entry.Name()
	if _, err = s.dmRepo.GetAttachmentByFileURL(ctx, url); errors.Is(err, pkg.ErrNotFound) {
		s.discardUnreferenced(ctx, &models.DMAttachment{FileURL: url})
		return nil
	}
	return err
}
