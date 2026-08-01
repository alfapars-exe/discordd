// Regression tests for UploadBadgeIcon's byte-derived (never
// client-claimed) MIME gate. Badge icons are served from a static handler
// with no serve-time re-sniff (see the comment in badge.go), so this
// upload-time gate is the only checkpoint — these tests also pin the
// "write the replay reader, not the original file" invariant, since a
// regression there silently truncates every uploaded icon.
package handlers

import (
	"bytes"
	"context"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"path/filepath"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/services"
)

var badgePNGMagic = []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}

// newBadgeIconRequest builds a multipart POST as if a browser submitted the
// badge icon form: one "icon" part carrying the given claimed Content-Type
// and body, plus the badge admin in the request context (UploadBadgeIcon
// authorizes on exact user ID).
func newBadgeIconRequest(t *testing.T, claimedType string, body []byte) *http.Request {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)

	hdr := textproto.MIMEHeader{}
	hdr.Set("Content-Disposition", `form-data; name="icon"; filename="icon.bin"`)
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

	req := httptest.NewRequest(http.MethodPost, "/api/badges/icon", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	user := &models.User{ID: services.BadgeAdminUserID}
	return req.WithContext(context.WithValue(req.Context(), UserContextKey, user))
}

// countBadgeFiles reports how many entries exist under uploadDir/badges,
// treating a not-yet-created directory (rejected before os.MkdirAll runs)
// as zero.
func countBadgeFiles(t *testing.T, uploadDir string) []os.DirEntry {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(uploadDir, "badges"))
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		t.Fatalf("ReadDir: %v", err)
	}
	return entries
}

func TestUploadBadgeIcon_rejectsHTMLDisguisedAsPNG(t *testing.T) {
	dir := t.TempDir()
	h := NewBadgeHandler(nil, dir)

	rec := httptest.NewRecorder()
	req := newBadgeIconRequest(t, "image/png", []byte("<!DOCTYPE html><html><body>boo</body></html>"))
	h.UploadBadgeIcon(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body: %s", rec.Code, rec.Body.String())
	}
	if entries := countBadgeFiles(t, dir); len(entries) != 0 {
		t.Errorf("rejected upload wrote %d files to disk", len(entries))
	}
}

func TestUploadBadgeIcon_acceptsRealPNGAndPreservesBytes(t *testing.T) {
	dir := t.TempDir()
	h := NewBadgeHandler(nil, dir)

	// Body deliberately exceeds pkg.SniffBufferSize (512): if the handler
	// wrote the original multipart file instead of the sniff's replay
	// reader, the first 512 bytes would be missing from disk.
	body := append(append([]byte{}, badgePNGMagic...), bytes.Repeat([]byte{0xAB}, 600)...)

	rec := httptest.NewRecorder()
	req := newBadgeIconRequest(t, "image/png", body)
	h.UploadBadgeIcon(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201, body: %s", rec.Code, rec.Body.String())
	}

	entries := countBadgeFiles(t, dir)
	if len(entries) != 1 {
		t.Fatalf("badges dir entries = %d, want 1", len(entries))
	}
	name := entries[0].Name()
	if filepath.Ext(name) != ".png" {
		t.Errorf("disk filename = %q, want .png suffix", name)
	}
	got, err := os.ReadFile(filepath.Join(dir, "badges", name))
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if !bytes.Equal(got, body) {
		t.Errorf("disk bytes diverge from input — replay reader not used")
	}
}

func TestUploadBadgeIcon_acceptsSVGClaimWithXMLProlog(t *testing.T) {
	dir := t.TempDir()
	h := NewBadgeHandler(nil, dir)

	rec := httptest.NewRecorder()
	req := newBadgeIconRequest(t, "image/svg+xml", []byte(`<?xml version="1.0"?><svg/>`))
	h.UploadBadgeIcon(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201, body: %s", rec.Code, rec.Body.String())
	}
	entries := countBadgeFiles(t, dir)
	if len(entries) != 1 {
		t.Fatalf("badges dir entries = %d, want 1", len(entries))
	}
	if filepath.Ext(entries[0].Name()) != ".svg" {
		t.Errorf("disk filename = %q, want .svg suffix", entries[0].Name())
	}
}

func TestUploadBadgeIcon_rejectsHTMLDisguisedAsSVG(t *testing.T) {
	dir := t.TempDir()
	h := NewBadgeHandler(nil, dir)

	rec := httptest.NewRecorder()
	req := newBadgeIconRequest(t, "image/svg+xml", []byte("<!DOCTYPE html><html>"))
	h.UploadBadgeIcon(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body: %s", rec.Code, rec.Body.String())
	}
	if entries := countBadgeFiles(t, dir); len(entries) != 0 {
		t.Errorf("rejected upload wrote %d files to disk", len(entries))
	}
}
