package services

import (
	"bytes"
	"context"
	"errors"
	"mime/multipart"
	"os"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
)

type groupUploadRepo struct {
	repository.GroupDMRepository
	attachment *models.GroupDMAttachment
	failure    error
}

func (r *groupUploadRepo) CreateAttachment(_ context.Context, a *models.GroupDMAttachment) error {
	r.attachment = a
	return r.failure
}

type groupUploadFile struct{ *bytes.Reader }

func (groupUploadFile) Close() error { return nil }
func TestGroupDMUploadLimitsAndMetadata(t *testing.T) {
	for _, test := range []struct {
		name       string
		size, hint int
		index      int
		dbFailure  bool
		success    bool
	}{{"actual size", 3, 1, 2, false, true}, {"exceeds actual limit", 40, 1, 0, false, false}, {"invalid index", 3, 3, 10, false, false}, {"failed metadata", 3, 3, 0, true, false}} {
		t.Run(test.name, func(t *testing.T) {
			dir := t.TempDir()
			repo := &groupUploadRepo{}
			if test.dbFailure {
				repo.failure = errors.New("database unavailable")
			}
			service := NewGroupDMUploadService(repo, dir, 32)
			a, err := service.Upload(context.Background(), "message", groupUploadFile{bytes.NewReader(bytes.Repeat([]byte{1}, test.size))}, &multipart.FileHeader{Filename: "encrypted_2.bin", Size: int64(test.hint)}, test.index)
			entries, readErr := os.ReadDir(dir)
			if readErr != nil {
				t.Fatal(readErr)
			}
			if test.success {
				if err != nil || a.FileSize == nil || *a.FileSize != int64(test.size) || a.FileKeyIndex == nil || *a.FileKeyIndex != test.index || len(entries) != 1 {
					t.Fatalf("a=%+v err=%v files=%d", a, err, len(entries))
				}
			} else if err == nil || len(entries) != 0 {
				t.Fatalf("failed upload left bytes: err=%v files=%d", err, len(entries))
			}
		})
	}
}
