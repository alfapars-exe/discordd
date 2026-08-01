// Package services — ReportUploadService: evidence file upload for reports.
// Only image files accepted. Stored in same upload directory, served via /api/uploads/.
package services

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"mime/multipart"
	"os"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
)

// ReportUploadService handles evidence file uploads for reports.
type ReportUploadService interface {
	Upload(ctx context.Context, reportID string, file multipart.File, header *multipart.FileHeader) (*models.ReportAttachment, error)
}

type reportUploadService struct {
	reportRepo repository.ReportRepository
	uploadDir  string
	maxSize    int64
}

func NewReportUploadService(
	reportRepo repository.ReportRepository,
	uploadDir string,
	maxSize int64,
) ReportUploadService {
	return &reportUploadService{
		reportRepo: reportRepo,
		uploadDir:  uploadDir,
		maxSize:    maxSize,
	}
}

var allowedReportMimeTypes = map[string]bool{
	"image/jpeg": true,
	"image/png":  true,
	"image/gif":  true,
	"image/webp": true,
}

// sniffImageUpload validates file's actual bytes (never the client-claimed
// Content-Type) against allowed and returns the sniffed MIME plus the
// replay reader that MUST be written to disk in place of file:
// pkg.SniffContentType consumes up to 512 bytes from file, so writing file
// itself would silently truncate the upload's first 512 bytes. rejectMsg
// lets each caller keep its own rejection wording (e.g. "for report
// evidence") verbatim instead of this helper picking one.
//
// Shared by ReportUploadService.Upload and FeedbackUploadService.Upload —
// both sniff-then-allowlist an image the same way.
func sniffImageUpload(file multipart.File, allowed map[string]bool, rejectMsg string) (mime string, replay io.Reader, err error) {
	sniffed, body, err := pkg.SniffContentType(file)
	if err != nil {
		return "", nil, fmt.Errorf("%w: unreadable upload", pkg.ErrBadRequest)
	}

	if !allowed[sniffed] {
		return "", nil, fmt.Errorf("%w: %s (got: %s)", pkg.ErrBadRequest, rejectMsg, sniffed)
	}

	return sniffed, body, nil
}

func (s *reportUploadService) Upload(ctx context.Context, reportID string, file multipart.File, header *multipart.FileHeader) (*models.ReportAttachment, error) {
	if header.Size > s.maxSize {
		return nil, fmt.Errorf("%w: file too large (max %dMB)", pkg.ErrBadRequest, s.maxSize/(1024*1024))
	}

	sniffed, replay, err := sniffImageUpload(file, allowedReportMimeTypes, "only images are allowed for report evidence")
	if err != nil {
		return nil, err
	}

	// Generate unique filename — sanitizeFilename defined in upload_service.go (same package)
	randomBytes := make([]byte, 8)
	if _, err := rand.Read(randomBytes); err != nil {
		return nil, fmt.Errorf("failed to generate random filename: %w", err)
	}
	safeFilename := sanitizeFilename(header.Filename)
	diskFilename := hex.EncodeToString(randomBytes) + "_" + safeFilename

	destPath, err := pkg.SafeJoin(s.uploadDir, diskFilename)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid upload destination", pkg.ErrBadRequest)
	}
	if err := writeUploadFile(destPath, replay, "failed to create file", "failed to save file", "failed to finalize file"); err != nil {
		return nil, err
	}

	fileSize := header.Size
	att := &models.ReportAttachment{
		ReportID: reportID,
		Filename: header.Filename,
		FileURL:  "/api/uploads/" + diskFilename,
		FileSize: &fileSize,
		MimeType: &sniffed,
	}

	if err := s.reportRepo.CreateAttachment(ctx, att); err != nil {
		_ = os.Remove(destPath) // best-effort cleanup; we're already returning the DB error
		return nil, fmt.Errorf("failed to create report attachment record: %w", err)
	}

	return att, nil
}
