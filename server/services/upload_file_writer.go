package services

import (
	"fmt"
	"io"
	"os"
)

// writeUploadFile copies src into a freshly created file at destPath and
// finalizes it, removing the partial file if anything fails. Close is
// checked because a buffered write error surfaces there and nowhere else --
// discarding it would report success for a truncated upload.
//
// This factors out the create/copy/close/cleanup control flow shared by
// SoundboardService.Create, FeedbackUploadService.Upload, and
// ReportUploadService.Upload. Callers historically wrapped each of the three
// failure phases with slightly different text (e.g. "create file" vs
// "failed to create file"), so createErrMsg/saveErrMsg/finalizeErrMsg let
// each caller keep its own wording verbatim instead of this helper picking
// one.
func writeUploadFile(destPath string, src io.Reader, createErrMsg, saveErrMsg, finalizeErrMsg string) error {
	destFile, err := os.Create(destPath) // #nosec G304 — caller verifies destPath via pkg.SafeJoin
	if err != nil {
		return fmt.Errorf("%s: %w", createErrMsg, err)
	}

	// Explicit close before any error path -- os.Remove fails on Windows
	// while the handle is open, leaving orphans behind.
	_, copyErr := io.Copy(destFile, src)
	closeErr := destFile.Close()
	if copyErr != nil {
		_ = os.Remove(destPath)
		return fmt.Errorf("%s: %w", saveErrMsg, copyErr)
	}
	if closeErr != nil {
		_ = os.Remove(destPath)
		return fmt.Errorf("%s: %w", finalizeErrMsg, closeErr)
	}

	return nil
}
