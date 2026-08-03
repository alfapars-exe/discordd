package services

import (
	"bytes"
	"context"
	"errors"
	"io"
	"mime/multipart"
	"net/textproto"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
)

// oggMagic mirrors the first six bytes of a real OGG stream; enough for
// http.DetectContentType to return "application/ogg" — the exact mismatch
// RefineMIME's extension fallback exists to work around.
var (
	pngMagic = []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}
	oggMagic = []byte("OggS\x00\x02")
)

// buildUpload creates an in-memory multipart file + header pair as if a
// browser had posted one attachment with the given filename, claimed
// Content-Type, and body bytes. It reproduces just enough of the
// multipart plumbing to feed UploadService.Upload directly.
func buildUpload(t *testing.T, filename, claimedType string, body []byte) (multipart.File, *multipart.FileHeader) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)

	hdr := textproto.MIMEHeader{}
	hdr.Set("Content-Disposition", `form-data; name="files"; filename="`+filename+`"`)
	if claimedType != "" {
		hdr.Set("Content-Type", claimedType)
	}
	part, err := mw.CreatePart(hdr)
	if err != nil {
		t.Fatalf("CreatePart: %v", err)
	}
	if _, err := part.Write(body); err != nil {
		t.Fatalf("part.Write: %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("mw.Close: %v", err)
	}

	reader := multipart.NewReader(&buf, mw.Boundary())
	form, err := reader.ReadForm(int64(len(body) + 4096))
	if err != nil {
		t.Fatalf("ReadForm: %v", err)
	}
	if len(form.File["files"]) == 0 {
		t.Fatalf("expected one file part, got none")
	}
	fh := form.File["files"][0]
	file, err := fh.Open()
	if err != nil {
		t.Fatalf("fh.Open: %v", err)
	}
	return file, fh
}

func newTestUploadService(t *testing.T, repo *testutil.MockAttachmentRepo) (UploadService, string) {
	t.Helper()
	dir := t.TempDir()
	svc := NewUploadService(repo, dir, 10*1024*1024)
	return svc, dir
}

func TestUploadService_acceptsPNG(t *testing.T) {
	repo := &testutil.MockAttachmentRepo{}
	svc, dir := newTestUploadService(t, repo)
	file, fh := buildUpload(t, "photo.png", "image/png", pngMagic)
	defer func() { _ = file.Close() }() // test cleanup — nothing to act on if teardown fails

	att, err := svc.Upload(context.Background(), "msg-1", file, fh, false)
	if err != nil {
		t.Fatalf("Upload: %v", err)
	}
	if att.MimeType == nil || *att.MimeType != "image/png" {
		t.Errorf("MimeType = %v, want image/png", att.MimeType)
	}
	// File must be on disk under uploadDir.
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Errorf("uploadDir entries = %d, want 1", len(entries))
	}
	if !strings.HasSuffix(entries[0].Name(), "_photo.png") {
		t.Errorf("disk filename = %q, missing _photo.png suffix", entries[0].Name())
	}
}

func TestUploadService_recoversOggByExtension(t *testing.T) {
	// The whole point of the sniff-or-extension fallback: an OGG file
	// gets classified as "application/ogg" by DetectContentType (not
	// "audio/ogg"), and would 400 without the extension fallback.
	repo := &testutil.MockAttachmentRepo{}
	svc, _ := newTestUploadService(t, repo)
	file, fh := buildUpload(t, "clip.ogg", "audio/ogg", oggMagic)
	defer func() { _ = file.Close() }() // test cleanup — nothing to act on if teardown fails

	att, err := svc.Upload(context.Background(), "msg-1", file, fh, false)
	if err != nil {
		t.Fatalf("Upload: %v", err)
	}
	if att.MimeType == nil || *att.MimeType != "audio/ogg" {
		t.Errorf("MimeType = %v, want audio/ogg", att.MimeType)
	}
}

func TestUploadService_acceptsUnknownTypeAsOctetStream(t *testing.T) {
	// All file types upload now. An executable with unclassifiable bytes
	// sniffs as application/octet-stream, .exe has no extension mapping,
	// and the upload SUCCEEDS with that generic recorded type. (Serving is
	// where such files are forced to download — see upload_download.go.)
	repo := &testutil.MockAttachmentRepo{}
	svc, dir := newTestUploadService(t, repo)
	file, fh := buildUpload(t, "shell.exe", "application/octet-stream",
		[]byte{0x00, 0x01, 0x02, 0x03, 0x04, 0x05})
	defer func() { _ = file.Close() }() // test cleanup — nothing to act on if teardown fails

	att, err := svc.Upload(context.Background(), "msg-1", file, fh, false)
	if err != nil {
		t.Fatalf("Upload of unknown type must succeed now: %v", err)
	}
	if att.MimeType == nil || *att.MimeType != "application/octet-stream" {
		t.Errorf("MimeType = %v, want application/octet-stream", att.MimeType)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Errorf("uploadDir entries = %d, want 1", len(entries))
	}
}

func TestUploadService_recordsSniffedTypeOverClaim(t *testing.T) {
	// HTML bytes disguised with a .png name and an image/png claim: the
	// recorded MIME must follow the BYTES (text/html), never the claim or
	// the extension — the serve-time inline/attachment decision depends on
	// downstream consumers not being lied to.
	repo := &testutil.MockAttachmentRepo{}
	svc, _ := newTestUploadService(t, repo)
	file, fh := buildUpload(t, "innocent.png", "image/png",
		[]byte("<!DOCTYPE html><html><body>boo</body></html>"))
	defer file.Close()

	att, err := svc.Upload(context.Background(), "msg-1", file, fh, false)
	if err != nil {
		t.Fatalf("Upload: %v", err)
	}
	if att.MimeType == nil || *att.MimeType != "text/html" {
		t.Errorf("MimeType = %v, want text/html (sniffed from bytes)", att.MimeType)
	}
}

func TestUploadService_e2eeBypassesSniff(t *testing.T) {
	// E2EE payloads are ciphertext — the bytes will never match the
	// allowlist. isEncrypted=true must skip the sniff step entirely.
	repo := &testutil.MockAttachmentRepo{}
	svc, _ := newTestUploadService(t, repo)
	body := []byte("this-would-fail-the-sniff-check")
	file, fh := buildUpload(t, "blob.enc", "application/octet-stream", body)
	defer file.Close()

	att, err := svc.Upload(context.Background(), "msg-1", file, fh, true)
	if err != nil {
		t.Fatalf("E2EE upload should not sniff: %v", err)
	}
	if att.MimeType == nil || *att.MimeType != "application/octet-stream" {
		t.Errorf("MimeType = %v, want application/octet-stream", att.MimeType)
	}
}

func TestUploadService_rejectsOversizedBeforeDiskWrite(t *testing.T) {
	repo := &testutil.MockAttachmentRepo{}
	dir := t.TempDir()
	svc := NewUploadService(repo, dir, 4) // 4-byte cap
	file, fh := buildUpload(t, "photo.png", "image/png", pngMagic)
	defer file.Close()

	_, err := svc.Upload(context.Background(), "msg-1", file, fh, false)
	if err == nil {
		t.Fatal("expected size rejection")
	}
	if !errors.Is(err, pkg.ErrBadRequest) {
		t.Errorf("err chain missing ErrBadRequest: %v", err)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Errorf("oversized upload wrote %d files", len(entries))
	}
}

func TestUploadService_cleansUpDiskOnRepoFailure(t *testing.T) {
	// If the DB write fails after the file has already been written to
	// disk, we mustn't leave an orphan. The service os.Removes the file
	// on repo error.
	dir := t.TempDir()
	repo := &testutil.MockAttachmentRepo{
		CreateFn: func(_ context.Context, _ *models.Attachment) error {
			return errors.New("db exploded")
		},
	}
	svc := NewUploadService(repo, dir, 10*1024*1024)
	file, fh := buildUpload(t, "photo.png", "image/png", pngMagic)
	defer file.Close()

	_, err := svc.Upload(context.Background(), "msg-1", file, fh, false)
	if err == nil {
		t.Fatal("expected error from failing repo")
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 0 {
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			names = append(names, filepath.Join(dir, e.Name()))
		}
		t.Errorf("orphan files left on disk after repo failure: %v", names)
	}
}

// silence unused-import warnings when only some tests reference a symbol.
var _ = io.Discard
