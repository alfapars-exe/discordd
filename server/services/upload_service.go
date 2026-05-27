package services

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"mime/multipart"
	"os"
	"path/filepath"
	"strings"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
)

// UploadService handles file upload validation, storage, and DB record creation.
// isEncrypted: E2EE files are client-side AES-256-GCM encrypted, sent as
// application/octet-stream — MIME whitelist is skipped for these.
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

var allowedMimeTypes = map[string]bool{
	"image/jpeg":      true,
	"image/png":       true,
	"image/gif":       true,
	"image/webp":      true,
	"video/mp4":       true,
	"video/webm":      true,
	"audio/mpeg":      true,
	"audio/ogg":       true,
	"application/pdf": true,
	"text/plain":      true,
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
	// so MIME sniffing isn't useful here — the bytes will always look like
	// random data and never match an allowlist. Skip the check, but still
	// record claimedType for client-side bookkeeping.
	mimeForRecord := claimedType
	body := io.Reader(file)
	if !isEncrypted {
		// Sniff the actual content type from the first 512 bytes instead
		// of trusting header.Header (client-controlled). A request that
		// labels a .js shell or .html XSS payload as image/png used to
		// sail through the previous allowlist check; sniffing closes
		// that and surfaces the mismatch in MIMETypeError so logs can
		// show "claimed X, bytes are Y".
		var realMIME string
		var err error
		realMIME, body, err = pkg.SniffAndValidate(file, claimedType, allowedMimeTypes)
		if err != nil {
			return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
		}
		mimeForRecord = realMIME
	}

	// Generate unique filename: {random_hex}_{original_filename}
	randomBytes := make([]byte, 8)
	if _, err := rand.Read(randomBytes); err != nil {
		return nil, fmt.Errorf("failed to generate random filename: %w", err)
	}
	safeFilename := sanitizeFilename(header.Filename)
	diskFilename := hex.EncodeToString(randomBytes) + "_" + safeFilename

	// SafeJoin verifies the destination stays inside uploadDir even
	// though diskFilename is already built from a random prefix and a
	// sanitized name — defense in depth against a future refactor that
	// might inadvertently relax sanitizeFilename.
	destPath, err := pkg.SafeJoin(s.uploadDir, diskFilename)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid upload destination", pkg.ErrBadRequest)
	}
	destFile, err := os.Create(destPath) // #nosec G304 — path containment verified by SafeJoin
	if err != nil {
		return nil, fmt.Errorf("failed to create file: %w", err)
	}
	defer destFile.Close()

	// `body` is either the original file reader (E2EE branch) or the
	// SniffAndValidate replay reader (sniff buffer + remaining file).
	// Either way, copying it drains the whole upload to disk.
	if _, err := io.Copy(destFile, body); err != nil {
		_ = os.Remove(destPath)
		return nil, fmt.Errorf("failed to save file: %w", err)
	}

	fileSize := header.Size
	attachment := &models.Attachment{
		MessageID: messageID,
		Filename:  header.Filename,
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

// sanitizeFilename strips path components and dangerous characters to prevent path traversal.
func sanitizeFilename(name string) string {
	name = filepath.Base(name)

	name = strings.Map(func(r rune) rune {
		if r == '/' || r == '\\' || r == '\x00' {
			return -1
		}
		return r
	}, name)

	if name == "" || name == "." || name == ".." {
		name = "unnamed"
	}

	return name
}
