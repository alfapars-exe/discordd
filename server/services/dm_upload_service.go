package services

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"os"
	"strings"
	"time"

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
	a, _, err := s.Stage(ctx, file, header, isEncrypted)
	if err != nil {
		return nil, err
	}
	a.DMMessageID = dmMessageID
	if err = s.dmRepo.CreateAttachment(ctx, a); err != nil {
		s.Discard(a)
		return nil, err
	}
	return a, nil
}

// Stage persists bytes before the message transaction. Discard never removes a
// committed attachment, including when the HTTP request lost its acknowledgment.
func (s *dmUploadService) Stage(ctx context.Context, file multipart.File, header *multipart.FileHeader, isEncrypted bool) (*models.DMAttachment, *models.DMUploadDigest, error) {
	if header.Size > s.maxSize {
		return nil, nil, fmt.Errorf("%w: file too large (max %dMB)", pkg.ErrBadRequest, s.maxSize/(1024*1024))
	}

	claimedType := header.Header.Get("Content-Type")
	if claimedType == "" {
		claimedType = "application/octet-stream"
	}
	claimedType = strings.TrimSpace(strings.Split(claimedType, ";")[0])

	// E2EE files arrive as application/octet-stream — sniffing is pointless.
	// Plaintext files: record the sniffed best-effort type; nothing is
	// rejected by type anymore (serve-time headers neutralize hostile
	// uploads — see the download handler).
	mimeForRecord := claimedType
	body := io.Reader(file)
	if !isEncrypted {
		sniffed, replay, err := pkg.SniffContentType(file)
		if err != nil {
			return nil, nil, fmt.Errorf("%w: unreadable upload", pkg.ErrBadRequest)
		}
		mimeForRecord = pkg.RefineMIME(sniffed, header.Filename)
		body = replay
	}

	randomBytes := make([]byte, 8)
	if _, err := rand.Read(randomBytes); err != nil {
		return nil, nil, fmt.Errorf("failed to generate random filename: %w", err)
	}
	safeFilename := pkg.SanitizeFilename(header.Filename)
	diskFilename := "dmstage_" + hex.EncodeToString(randomBytes) + "_" + safeFilename

	destPath, err := pkg.SafeJoin(s.uploadDir, diskFilename)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: invalid upload destination", pkg.ErrBadRequest)
	}
	destFile, err := os.OpenFile(destPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600) // #nosec G304 — verified by SafeJoin
	if err != nil {
		return nil, nil, fmt.Errorf("failed to create file: %w", err)
	}

	// Explicit close before any error path — os.Remove fails on Windows
	// while the handle is open, leaving orphans behind.
	digest := sha256.New()
	written, copyErr := io.Copy(destFile, io.TeeReader(io.LimitReader(body, s.maxSize+1), digest))
	if copyErr == nil && written != header.Size {
		copyErr = fmt.Errorf("upload size mismatch")
	}
	if copyErr == nil {
		copyErr = destFile.Sync()
	}
	closeErr := destFile.Close()
	if copyErr != nil {
		_ = os.Remove(destPath)
		return nil, nil, fmt.Errorf("failed to save file: %w", copyErr)
	}
	if closeErr != nil {
		_ = os.Remove(destPath)
		return nil, nil, fmt.Errorf("failed to finalize file: %w", closeErr)
	}

	fileSize := header.Size
	attachment := &models.DMAttachment{

		Filename: safeFilename,
		FileURL:  "/api/uploads/" + diskFilename,
		FileSize: &fileSize,
		MimeType: &mimeForRecord,
	}

	return attachment, &models.DMUploadDigest{Filename: safeFilename, Size: fileSize, MIME: mimeForRecord, SHA256: hex.EncodeToString(digest.Sum(nil))}, nil
}

func (s *dmUploadService) Discard(a *models.DMAttachment) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s.discardUnreferenced(ctx, a)
}
func (s *dmUploadService) discardUnreferenced(ctx context.Context, a *models.DMAttachment) {
	_, err := s.dmRepo.GetAttachmentByFileURL(ctx, a.FileURL)
	if !errors.Is(err, pkg.ErrNotFound) {
		return
	}
	name := strings.TrimPrefix(a.FileURL, "/api/uploads/")
	if dest, err := pkg.SafeJoin(s.uploadDir, name); err == nil {
		_ = os.Remove(dest)
	}
}
