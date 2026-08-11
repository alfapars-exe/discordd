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

// UploadService handles file upload validation, storage, and DB record creation.
// isEncrypted: E2EE files are client-side AES-256-GCM encrypted, sent as
// application/octet-stream — content sniffing is pointless for these.
//
// Every file type is accepted (size limit still applies). The recorded
// MimeType is the SNIFFED best-effort type, advisory/display-only: the
// download handler re-sniffs at serve time and forces non-displayable
// types to a forced download, so a hostile upload can't execute on the
// app origin no matter what gets recorded here.
type UploadService interface {
	Upload(ctx context.Context, messageID string, file multipart.File, header *multipart.FileHeader, isEncrypted bool) (*models.Attachment, error)
}

type uploadService struct {
	attachmentRepo repository.AttachmentRepository
	uploadDir      string
	maxSize        int64
}

func NewUploadService(
	attachmentRepo repository.AttachmentRepository,
	uploadDir string,
	maxSize int64,
) UploadService {
	return &uploadService{
		attachmentRepo: attachmentRepo,
		uploadDir:      uploadDir,
		maxSize:        maxSize,
	}
}

func (s *uploadService) Upload(ctx context.Context, messageID string, file multipart.File, header *multipart.FileHeader, isEncrypted bool) (*models.Attachment, error) {
	if header.Size > s.maxSize {
		return nil, fmt.Errorf("%w: file too large (max %dMB)", pkg.ErrBadRequest, s.maxSize/(1024*1024))
	}

	claimedType := header.Header.Get("Content-Type")
	if claimedType == "" {
		claimedType = "application/octet-stream"
	}
	claimedType = strings.TrimSpace(strings.Split(claimedType, ";")[0])

	// E2EE uploads are opaque ciphertext blobs from the server's point of
	// view (the client-side AES-GCM step rewrites the body before posting),
	// so MIME sniffing isn't useful here — the bytes always look like
	// random data. Record claimedType for client-side bookkeeping.
	mimeForRecord := claimedType
	body := io.Reader(file)
	if !isEncrypted {
		// Sniff the first 512 bytes (source of truth, never the client
		// header) and refine only generic results via the controlled
		// extension map (OGG containers, raw MP3s). Recording, not
		// gating: no file type is rejected anymore — serve-time headers
		// are what keep hostile uploads from executing (see the download
		// handler).
		sniffed, replay, err := pkg.SniffContentType(file)
		if err != nil {
			return nil, fmt.Errorf("%w: unreadable upload", pkg.ErrBadRequest)
		}
		mimeForRecord = pkg.RefineMIME(sniffed, header.Filename)
		body = replay
	}

	// Generate unique filename: {random_hex}_{original_filename}
	randomBytes := make([]byte, 8)
	if _, err := rand.Read(randomBytes); err != nil {
		return nil, fmt.Errorf("failed to generate random filename: %w", err)
	}
	safeFilename := pkg.SanitizeFilename(header.Filename)
	diskFilename := hex.EncodeToString(randomBytes) + "_" + safeFilename

	// SafeJoin verifies the destination stays inside uploadDir even
	// though diskFilename is already built from a random prefix and a
	// sanitized name — defense in depth against a future refactor that
	// might inadvertently relax pkg.SanitizeFilename.
	destPath, err := pkg.SafeJoin(s.uploadDir, diskFilename)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid upload destination", pkg.ErrBadRequest)
	}
	destFile, err := os.Create(destPath) // #nosec G304 — path containment verified by SafeJoin
	if err != nil {
		return nil, fmt.Errorf("failed to create file: %w", err)
	}

	// `body` is either the original file reader (E2EE branch) or the
	// sniff replay reader (sniff buffer + remaining file). Either way,
	// copying it drains the whole upload to disk.
	_, copyErr := io.Copy(destFile, body)
	// Windows keeps the file handle exclusive: os.Remove fails while
	// destFile is still open. Close explicitly BEFORE any cleanup path
	// so error branches actually delete the orphan.
	closeErr := destFile.Close()
	if copyErr != nil {
		_ = os.Remove(destPath)
		return nil, fmt.Errorf("failed to save file: %w", copyErr)
	}
	if closeErr != nil {
		_ = os.Remove(destPath)
		return nil, fmt.Errorf("failed to finalize file: %w", closeErr)
	}

	fileSize := header.Size
	attachment := &models.Attachment{
		MessageID: messageID,
		Filename:  safeFilename,
		FileURL:   "/api/uploads/" + diskFilename,
		FileSize:  &fileSize,
		MimeType:  &mimeForRecord,
	}

	if err := s.attachmentRepo.Create(ctx, attachment); err != nil {
		_ = os.Remove(destPath)
		return nil, fmt.Errorf("failed to create attachment record: %w", err)
	}

	return attachment, nil
}
