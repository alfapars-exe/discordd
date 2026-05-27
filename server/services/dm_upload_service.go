package services

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"mime/multipart"
	"os"
	"strings"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
)

// DMUploadService handles DM file uploads. Parallel to UploadService for channel messages.
type DMUploadService interface {
	Upload(ctx context.Context, dmMessageID string, file multipart.File, header *multipart.FileHeader, isEncrypted bool) (*models.DMAttachment, error)
}

type dmUploadService struct {
	dmRepo    repository.DMRepository
	uploadDir string
	maxSize   int64
}

func NewDMUploadService(
	dmRepo repository.DMRepository,
	uploadDir string,
	maxSize int64,
) DMUploadService {
	return &dmUploadService{
		dmRepo:    dmRepo,
		uploadDir: uploadDir,
		maxSize:   maxSize,
	}
}

func (s *dmUploadService) Upload(ctx context.Context, dmMessageID string, file multipart.File, header *multipart.FileHeader, isEncrypted bool) (*models.DMAttachment, error) {
	if header.Size > s.maxSize {
		return nil, fmt.Errorf("%w: file too large (max %dMB)", pkg.ErrBadRequest, s.maxSize/(1024*1024))
	}

	claimedType := header.Header.Get("Content-Type")
	if claimedType == "" {
		claimedType = "application/octet-stream"
	}
	claimedType = strings.TrimSpace(strings.Split(claimedType, ";")[0])

	// E2EE files arrive as application/octet-stream — skip MIME whitelist
	mimeForRecord := claimedType
	body := io.Reader(file)
	if !isEncrypted {
		realMIME, replay, err := pkg.SniffAndValidate(file, claimedType, allowedMimeTypes)
		if err != nil {
			return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
		}
		mimeForRecord = realMIME
		body = replay
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
	destFile, err := os.Create(destPath) // #nosec G304 — verified by SafeJoin
	if err != nil {
		return nil, fmt.Errorf("failed to create file: %w", err)
	}
	defer destFile.Close()

	if _, err := io.Copy(destFile, file); err != nil {
		_ = os.Remove(destPath)
		return nil, fmt.Errorf("failed to save file: %w", err)
	}

	fileSize := header.Size
	attachment := &models.DMAttachment{
		DMMessageID: dmMessageID,
		Filename:    header.Filename,
		FileURL:     "/api/uploads/" + diskFilename,
		FileSize:    &fileSize,
		MimeType:    &mimeBase,
	}

	if err := s.dmRepo.CreateAttachment(ctx, attachment); err != nil {
		os.Remove(destPath)
		return nil, fmt.Errorf("failed to create DM attachment record: %w", err)
	}

	return attachment, nil
}
