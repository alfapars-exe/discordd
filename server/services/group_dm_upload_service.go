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

type GroupDMUploadService interface {
	Upload(context.Context, string, multipart.File, *multipart.FileHeader, int) (*models.GroupDMAttachment, error)
}
type groupDMUploadService struct {
	repo      repository.GroupDMRepository
	uploadDir string
	maxSize   int64
}

func NewGroupDMUploadService(repo repository.GroupDMRepository, uploadDir string, maxSize int64) GroupDMUploadService {
	return &groupDMUploadService{repo: repo, uploadDir: uploadDir, maxSize: maxSize}
}
func (s *groupDMUploadService) Upload(ctx context.Context, messageID string, file multipart.File, header *multipart.FileHeader, fileKeyIndex int) (*models.GroupDMAttachment, error) {
	if fileKeyIndex < 0 || fileKeyIndex >= 10 {
		return nil, fmt.Errorf("%w: invalid file key index", pkg.ErrBadRequest)
	}
	if header.Size > s.maxSize {
		return nil, fmt.Errorf("%w: file too large (max %dMB)", pkg.ErrBadRequest, s.maxSize/(1024*1024))
	}
	claimed := strings.TrimSpace(strings.Split(header.Header.Get("Content-Type"), ";")[0])
	if claimed == "" {
		claimed = "application/octet-stream"
	}
	random := make([]byte, 8)
	if _, err := rand.Read(random); err != nil {
		return nil, err
	}
	safe := pkg.SanitizeFilename(header.Filename)
	disk := hex.EncodeToString(random) + "_" + safe
	path, err := pkg.SafeJoin(s.uploadDir, disk)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid upload destination", pkg.ErrBadRequest)
	}
	dest, err := os.Create(path)
	if err != nil {
		return nil, fmt.Errorf("failed to create file: %w", err)
	}
	written, copyErr := io.Copy(dest, io.LimitReader(file, s.maxSize+1))
	closeErr := dest.Close()
	if copyErr != nil {
		_ = os.Remove(path)
		return nil, fmt.Errorf("failed to save file: %w", copyErr)
	}
	if closeErr != nil {
		_ = os.Remove(path)
		return nil, fmt.Errorf("failed to finalize file: %w", closeErr)
	}
	if written > s.maxSize {
		_ = os.Remove(path)
		return nil, fmt.Errorf("%w: file too large", pkg.ErrBadRequest)
	}
	size := written
	a := &models.GroupDMAttachment{GroupMessageID: messageID, Filename: safe, FileURL: "/api/uploads/" + disk, FileSize: &size, MimeType: &claimed, FileKeyIndex: &fileKeyIndex}
	if err := s.repo.CreateAttachment(ctx, a); err != nil {
		_ = os.Remove(path)
		return nil, err
	}
	return a, nil
}
