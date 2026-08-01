// Regression tests for the byte-derived (never client-claimed) MIME gate
// shared by ReportUploadService, FeedbackUploadService, and
// SoundboardService.Create. Each test also pins the "write the replay
// reader, not the original file" invariant: SniffContentType consumes up
// to pkg.SniffBufferSize bytes from its source, so a caller that writes the
// original reader to disk instead of the replay reader silently truncates
// every upload's first bytes.
//
// buildUpload, pngMagic, and oggMagic are declared in upload_service_test.go
// (same package) — reused here rather than redefined.
package services

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
)

// ─── ReportUploadService ───

func TestReportUpload_rejectsHTMLDisguisedAsPNG(t *testing.T) {
	dir := t.TempDir()
	// The reject path never reaches the repository, so a nil repo is safe.
	svc := NewReportUploadService(nil, dir, 10*1024*1024)
	file, fh := buildUpload(t, "evidence.png", "image/png",
		[]byte("<!DOCTYPE html><html><body>boo</body></html>"))
	defer func() { _ = file.Close() }()

	_, err := svc.Upload(context.Background(), "report-1", file, fh)
	if !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("expected ErrBadRequest, got %v", err)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Errorf("rejected upload wrote %d files to disk", len(entries))
	}
}

func TestReportUpload_acceptsRealPNGAndPreservesBytes(t *testing.T) {
	dir := t.TempDir()
	svc := NewReportUploadService(stubReportRepo{}, dir, 10*1024*1024)
	// Body deliberately exceeds pkg.SniffBufferSize: if the service wrote
	// `file` instead of the sniff's replay reader, the first 512 bytes
	// would be missing from disk and this comparison would fail.
	body := append(append([]byte{}, pngMagic...), bytes.Repeat([]byte{0xAB}, 600)...)
	file, fh := buildUpload(t, "evidence.png", "image/png", body)
	defer func() { _ = file.Close() }()

	att, err := svc.Upload(context.Background(), "report-1", file, fh)
	if err != nil {
		t.Fatalf("Upload: %v", err)
	}
	if att.MimeType == nil || *att.MimeType != "image/png" {
		t.Errorf("MimeType = %v, want image/png", att.MimeType)
	}

	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("uploadDir entries = %d, want 1", len(entries))
	}
	got, err := os.ReadFile(filepath.Join(dir, entries[0].Name()))
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if !bytes.Equal(got, body) {
		t.Errorf("disk bytes diverge from input — replay reader not used")
	}
}

// stubReportRepo is a minimal repository.ReportRepository implementation
// for tests that need Upload to reach CreateAttachment. Kept local to this
// package (not testutil) per task scope.
type stubReportRepo struct{}

func (stubReportRepo) Create(context.Context, *models.Report) error { return nil }
func (stubReportRepo) GetByID(context.Context, string) (*models.Report, error) {
	return nil, nil
}
func (stubReportRepo) ListPending(context.Context, int, int) ([]models.ReportWithUsers, int, error) {
	return nil, 0, nil
}
func (stubReportRepo) ListAll(context.Context, int, int) ([]models.ReportWithUsers, int, error) {
	return nil, 0, nil
}
func (stubReportRepo) UpdateStatus(context.Context, string, models.ReportStatus, string) error {
	return nil
}
func (stubReportRepo) HasPendingReport(context.Context, string, string) (bool, error) {
	return false, nil
}
func (stubReportRepo) CreateAttachment(context.Context, *models.ReportAttachment) error {
	return nil
}
func (stubReportRepo) GetAttachmentsByReportID(context.Context, string) ([]models.ReportAttachment, error) {
	return nil, nil
}

var _ repository.ReportRepository = stubReportRepo{}

// ─── FeedbackUploadService ───

func TestFeedbackUpload_rejectsHTMLDisguisedAsPNG(t *testing.T) {
	dir := t.TempDir()
	svc := NewFeedbackUploadService(nil, dir, 10*1024*1024)
	file, fh := buildUpload(t, "evidence.png", "image/png",
		[]byte("<!DOCTYPE html><html><body>boo</body></html>"))
	defer func() { _ = file.Close() }()

	_, err := svc.Upload(context.Background(), "ticket-1", nil, file, fh)
	if !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("expected ErrBadRequest, got %v", err)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Errorf("rejected upload wrote %d files to disk", len(entries))
	}
}

func TestFeedbackUpload_acceptsRealPNGAndPreservesBytes(t *testing.T) {
	dir := t.TempDir()
	svc := NewFeedbackUploadService(stubFeedbackRepo{}, dir, 10*1024*1024)
	body := append(append([]byte{}, pngMagic...), bytes.Repeat([]byte{0xCD}, 600)...)
	file, fh := buildUpload(t, "evidence.png", "image/png", body)
	defer func() { _ = file.Close() }()

	att, err := svc.Upload(context.Background(), "ticket-1", nil, file, fh)
	if err != nil {
		t.Fatalf("Upload: %v", err)
	}
	if att.MimeType == nil || *att.MimeType != "image/png" {
		t.Errorf("MimeType = %v, want image/png", att.MimeType)
	}

	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("uploadDir entries = %d, want 1", len(entries))
	}
	got, err := os.ReadFile(filepath.Join(dir, entries[0].Name()))
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if !bytes.Equal(got, body) {
		t.Errorf("disk bytes diverge from input — replay reader not used")
	}
}

// stubFeedbackRepo is a minimal repository.FeedbackRepository implementation,
// local to this package for the same reason as stubReportRepo above.
type stubFeedbackRepo struct{}

func (stubFeedbackRepo) CreateTicket(context.Context, *models.FeedbackTicket) error { return nil }
func (stubFeedbackRepo) GetTicketByID(context.Context, string) (*models.FeedbackTicketWithUser, error) {
	return nil, nil
}
func (stubFeedbackRepo) ListByUser(context.Context, string, int, int) ([]models.FeedbackTicketWithUser, int, error) {
	return nil, 0, nil
}
func (stubFeedbackRepo) ListAll(context.Context, string, string, int, int) ([]models.FeedbackTicketWithUser, int, error) {
	return nil, 0, nil
}
func (stubFeedbackRepo) UpdateStatus(context.Context, string, models.FeedbackStatus) error {
	return nil
}
func (stubFeedbackRepo) DeleteTicket(context.Context, string) error { return nil }
func (stubFeedbackRepo) CreateReply(context.Context, *models.FeedbackReply) error {
	return nil
}
func (stubFeedbackRepo) GetRepliesByTicketID(context.Context, string) ([]models.FeedbackReplyWithUser, error) {
	return nil, nil
}
func (stubFeedbackRepo) CreateAttachment(context.Context, *models.FeedbackAttachment) error {
	return nil
}
func (stubFeedbackRepo) GetAttachmentsByTicketID(context.Context, string) ([]models.FeedbackAttachment, error) {
	return nil, nil
}

var _ repository.FeedbackRepository = stubFeedbackRepo{}

// ─── SoundboardService.Create ───

func TestSoundboardUpload_acceptsRIFFWaveClaimedAsAudioWav(t *testing.T) {
	// Regression pin for the audio/wave vs audio/wav mismatch: Go's sniffer
	// reports RIFF/WAVE bytes as "audio/wave", not "audio/wav" (the client's
	// claim, and the only spelling in soundAllowedMimeTypes). Without
	// "audio/wave" in soundAllowedSniffedTypes every WAV upload would 400 —
	// and WAV is the format the client converts captured audio to before
	// upload, so this is the single most common real-world path.
	dir := t.TempDir()
	svc := newTestSoundboardService(&testutil.MockSoundboardRepo{}, dir)

	body := append([]byte("RIFF\x00\x00\x00\x00WAVE"), bytes.Repeat([]byte{0x00}, 600)...)
	file, fh := buildUpload(t, "clip.wav", "audio/wav", body)
	defer func() { _ = file.Close() }()

	req := &models.CreateSoundboardSoundRequest{Name: "boop"}
	if _, err := svc.Create(context.Background(), "srv1", "user1", req, file, fh, 500); err != nil {
		t.Fatalf("expected RIFF/WAVE upload to be accepted, got: %v", err)
	}

	soundDir := filepath.Join(dir, soundboardSubdir)
	entries, _ := os.ReadDir(soundDir)
	if len(entries) != 1 {
		t.Fatalf("soundboard dir entries = %d, want 1", len(entries))
	}
	got, err := os.ReadFile(filepath.Join(soundDir, entries[0].Name()))
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if !bytes.Equal(got, body) {
		t.Errorf("disk bytes diverge from input — replay reader not used")
	}
}

func TestSoundboardUpload_rejectsHTMLDisguisedAsMPEG(t *testing.T) {
	dir := t.TempDir()
	svc := newTestSoundboardService(&testutil.MockSoundboardRepo{}, dir)

	file, fh := buildUpload(t, "clip.mp3", "audio/mpeg",
		[]byte("<!DOCTYPE html><html><body>boo</body></html>"))
	defer func() { _ = file.Close() }()

	req := &models.CreateSoundboardSoundRequest{Name: "boop"}
	_, err := svc.Create(context.Background(), "srv1", "user1", req, file, fh, 500)
	if !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("expected ErrBadRequest, got %v", err)
	}
	soundDir := filepath.Join(dir, soundboardSubdir)
	if entries, _ := os.ReadDir(soundDir); len(entries) != 0 {
		t.Errorf("rejected upload wrote %d files to disk", len(entries))
	}
}

func TestSoundboardUpload_acceptsGenericBinaryByExtensionFallback(t *testing.T) {
	// Go's sniff dictionary has no AAC signature at all: unclassifiable
	// bytes sniff as "application/octet-stream". The extension fallback is
	// what keeps legitimate AAC/M4A clips uploadable.
	dir := t.TempDir()
	svc := newTestSoundboardService(&testutil.MockSoundboardRepo{}, dir)

	file, fh := buildUpload(t, "clip.aac", "audio/aac",
		[]byte{0x00, 0x01, 0x02, 0x03, 0x04, 0x05})
	defer func() { _ = file.Close() }()

	req := &models.CreateSoundboardSoundRequest{Name: "boop"}
	if _, err := svc.Create(context.Background(), "srv1", "user1", req, file, fh, 500); err != nil {
		t.Fatalf("expected AAC upload to be accepted via extension fallback, got: %v", err)
	}
	soundDir := filepath.Join(dir, soundboardSubdir)
	if entries, _ := os.ReadDir(soundDir); len(entries) != 1 {
		t.Errorf("soundboard dir entries = %d, want 1", len(entries))
	}
}
