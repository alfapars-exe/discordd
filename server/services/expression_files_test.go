package services

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

// testPNGBytes / testGIFBytes carry the real magic prefixes the clone path
// checks for.
var (
	testPNGBytes = append([]byte("\x89PNG\r\n\x1a\n"), []byte("png-body")...)
	testGIFBytes = append([]byte("GIF89a"), []byte("gif-body")...)
)

func TestPublishAndReadOwnExpressionFile_RoundTrip(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, stickerSubdir)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		t.Fatal(err)
	}
	url, err := publishExpressionFile(dir, stickerSubdir, "0123456789abcdef.png", testPNGBytes)
	if err != nil {
		t.Fatalf("publish: %v", err)
	}
	if url != "/api/uploads/stickers/0123456789abcdef.png" {
		t.Errorf("url = %q", url)
	}
	got, err := readOwnExpressionFile(root, url, expressionPNGMagic)
	if err != nil || !bytes.Equal(got, testPNGBytes) {
		t.Errorf("read back = %q, %v", got, err)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Errorf("dir holds %d entries, want only the published file (no temp left)", len(entries))
	}
}

func TestReadOwnExpressionFile_Rejects(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, emojiSubdir)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		t.Fatal(err)
	}
	write := func(name string, data []byte) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("aaaaaaaaaaaaaaaa.png", testPNGBytes)
	write("bbbbbbbbbbbbbbbb.png", []byte("not a png at all"))
	write("cccccccccccccccc.png", append(append([]byte{}, testPNGBytes...), make([]byte, models.ExpressionStoredFileMaxBytes)...))
	// A file outside the expression subdirectories must never be reachable.
	if err := os.WriteFile(filepath.Join(root, "secret.png"), testPNGBytes, 0o600); err != nil {
		t.Fatal(err)
	}

	internal := []struct {
		name, url string
	}{
		{"traversal", "/api/uploads/../secret.png"},
		{"traversal inside subdir", "/api/uploads/emojis/../secret.png"},
		{"outside prefix", "/static/emojis/aaaaaaaaaaaaaaaa.png"},
		{"other upload subdir", "/api/uploads/avatars/aaaaaaaaaaaaaaaa.png"},
		{"non-hex name", "/api/uploads/emojis/secret.png"},
		{"oversized", "/api/uploads/emojis/cccccccccccccccc.png"},
		{"wrong magic", "/api/uploads/emojis/bbbbbbbbbbbbbbbb.png"},
	}
	for _, tc := range internal {
		t.Run(tc.name, func(t *testing.T) {
			got, err := readOwnExpressionFile(root, tc.url, expressionPNGMagic)
			if err == nil || got != nil {
				t.Fatalf("readOwnExpressionFile(%q) = %d bytes, %v — want an error", tc.url, len(got), err)
			}
			if errors.Is(err, models.ErrExpressionNotFound) || !errors.Is(err, pkg.ErrInternal) {
				t.Errorf("err = %v, want an internal (not not-found) error", err)
			}
		})
	}

	if _, err := readOwnExpressionFile(root, "/api/uploads/emojis/aaaaaaaaaaaaaaaa.png", expressionGIFMagic); err == nil {
		t.Error("PNG accepted where a GIF was expected")
	}
	if _, err := readOwnExpressionFile(root, "/api/uploads/emojis/dddddddddddddddd.png", expressionPNGMagic); !errors.Is(err, models.ErrExpressionNotFound) {
		t.Errorf("missing file: err = %v, want ErrExpressionNotFound", err)
	}
}
