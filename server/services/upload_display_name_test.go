package services

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
)

// spoofedName carries U+202E RIGHT-TO-LEFT OVERRIDE between the stem and the
// extension. Rendered, the tail reverses: this reads as "faturaexe.png" in a
// browser or chat client, so an executable presents itself as a picture to
// whoever is deciding whether to open it.
//
// Written as an escape and never as a literal — a literal here would reorder
// this source file in every editor and diff that displays it.
const spoofedName = "fatura\u202Egnp.png"

// Each upload service derives two names from the client's filename: the one
// written to disk, and the one stored on the record for clients to render.
// pkg.SanitizeFilename is unit-tested on its own; these cases bind the
// WIRING, which is where the guarantee actually goes missing. Reverting any
// call site to header.Filename is a one-word edit, and before this test no
// assertion in the package would have caught it.
//
// The DM upload service shares the identical shape but has no repository
// stub in this package, so it is not covered here.
func TestUploadServices_storeSanitizedDisplayName(t *testing.T) {
	want := pkg.SanitizeFilename(spoofedName)
	if strings.ContainsRune(want, '\u202E') {
		t.Fatalf("sanitizer itself kept the override: %q", want)
	}

	t.Run("message attachment", func(t *testing.T) {
		dir := t.TempDir()
		svc := NewUploadService(&testutil.MockAttachmentRepo{}, dir, 10*1024*1024)
		file, fh := buildUpload(t, spoofedName, "image/png", pngMagic)
		defer func() { _ = file.Close() }()

		att, err := svc.Upload(context.Background(), "msg-1", file, fh, false)
		if err != nil {
			t.Fatalf("Upload: %v", err)
		}
		assertSanitizedNames(t, dir, att.Filename, want)
	})

	t.Run("report attachment", func(t *testing.T) {
		dir := t.TempDir()
		svc := NewReportUploadService(stubReportRepo{}, dir, 10*1024*1024)
		file, fh := buildUpload(t, spoofedName, "image/png", pngMagic)
		defer func() { _ = file.Close() }()

		att, err := svc.Upload(context.Background(), "report-1", file, fh)
		if err != nil {
			t.Fatalf("Upload: %v", err)
		}
		assertSanitizedNames(t, dir, att.Filename, want)
	})

	t.Run("feedback attachment", func(t *testing.T) {
		dir := t.TempDir()
		svc := NewFeedbackUploadService(stubFeedbackRepo{}, dir, 10*1024*1024)
		file, fh := buildUpload(t, spoofedName, "image/png", pngMagic)
		defer func() { _ = file.Close() }()

		att, err := svc.Upload(context.Background(), "ticket-1", nil, file, fh)
		if err != nil {
			t.Fatalf("Upload: %v", err)
		}
		assertSanitizedNames(t, dir, att.Filename, want)
	})
}

// assertSanitizedNames checks both names derived from the upload: the record
// field clients render, and the single file left behind in dir.
func assertSanitizedNames(t *testing.T, dir, stored, want string) {
	t.Helper()
	if stored != want {
		t.Errorf("stored display name = %q, want %q", stored, want)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("uploadDir entries = %d, want 1", len(entries))
	}
	if strings.ContainsRune(entries[0].Name(), '\u202E') {
		t.Errorf("disk name kept the override: %q", entries[0].Name())
	}
}
