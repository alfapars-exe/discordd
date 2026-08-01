package services

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"mime/multipart"
	"os"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/google/uuid"
)

type FeedbackUploadService interface {
	Upload(ctx context.Context, ticketID string, replyID *string, file multipart.File, header *multipart.FileHeader) (*models.FeedbackAttachment, error)
}

type feedbackUploadService struct {
	feedbackRepo repository.FeedbackRepository
	uploadDir    string
	maxSize      int64
}

func NewFeedbackUploadService(
	feedbackRepo repository.FeedbackRepository,
	uploadDir string,
	maxSize int64,
) FeedbackUploadService {
	return &feedbackUploadService{
		feedbackRepo: feedbackRepo,
		uploadDir:    uploadDir,
		maxSize:      maxSize,
	}
}

var allowedFeedbackMimeTypes = map[string]bool{
	"image/jpeg": true,
	"image/png":  true,
	"image/gif":  true,
	"image/webp": true,
}

func (s *feedbackUploadService) Upload(ctx context.Context, ticketID string, replyID *string, file multipart.File, header *multipart.FileHeader) (*models.FeedbackAttachment, error) {
	if header.Size > s.maxSize {
		return nil, fmt.Errorf("%w: file too large (max %dMB)", pkg.ErrBadRequest, s.maxSize/(1024*1024))
	}

	// The client-declared Content-Type header is attacker-controlled and
	// never trusted for the allowlist decision — sniff the actual bytes
	// instead (mirrors upload_service.go / dm_upload_service.go). replay
	// MUST be what's written to disk: SniffContentType consumes up to 512
	// bytes from file, so writing file itself would silently truncate the
	// upload's first 512 bytes.
	sniffed, replay, err := pkg.SniffContentType(file)
	if err != nil {
		return nil, fmt.Errorf("%w: unreadable upload", pkg.ErrBadRequest)
	}

	if !allowedFeedbackMimeTypes[sniffed] {
		return nil, fmt.Errorf("%w: only images are allowed (got: %s)", pkg.ErrBadRequest, sniffed)
	}

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
	att := &models.FeedbackAttachment{
		ID:       uuid.New().String(),
		TicketID: ticketID,
		ReplyID:  replyID,
		Filename: header.Filename,
		FileURL:  "/api/uploads/" + diskFilename,
		FileSize: &fileSize,
		MimeType: &sniffed,
	}

	if err := s.feedbackRepo.CreateAttachment(ctx, att); err != nil {
		_ = os.Remove(destPath) // best-effort cleanup; we're already returning the DB error
		return nil, fmt.Errorf("failed to create feedback attachment record: %w", err)
	}

	return att, nil
}
