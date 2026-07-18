package pkg

import (
	"bytes"
	"errors"
	"io"
	"strings"
	"testing"
)

// Minimal magic-byte prefixes recognized by http.DetectContentType.
var (
	pngMagic  = []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}
	jpegMagic = []byte{0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 'J', 'F', 'I', 'F'}
	gifMagic  = []byte("GIF89a")
	pdfMagic  = []byte("%PDF-1.4\n")
	// http.DetectContentType returns "application/ogg" for OGG containers,
	// but the audio allowlist entry is "audio/ogg". The extension fallback
	// is what actually makes ogg uploads work.
	oggMagic = []byte("OggS\x00\x02")
)

func TestSniffContentType_recognizesMagicBytes(t *testing.T) {
	tests := []struct {
		name string
		body []byte
		want string
	}{
		{"png", pngMagic, "image/png"},
		{"jpeg", jpegMagic, "image/jpeg"},
		{"gif", gifMagic, "image/gif"},
		{"pdf", pdfMagic, "application/pdf"},
		{"plaintext", []byte("hello world"), "text/plain"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			mime, body, err := SniffContentType(bytes.NewReader(tc.body))
			if err != nil {
				t.Fatalf("SniffContentType: %v", err)
			}
			if mime != tc.want {
				t.Errorf("mime = %q, want %q", mime, tc.want)
			}
			// Replay must reproduce the exact original bytes.
			replayed, _ := io.ReadAll(body)
			if !bytes.Equal(replayed, tc.body) {
				t.Errorf("replay = %v, want %v", replayed, tc.body)
			}
		})
	}
}

func TestSniffContentType_shortFileStillSniffs(t *testing.T) {
	// 4-byte file (shorter than SniffBufferSize) — sniffer must not choke.
	body := pngMagic[:4]
	mime, replay, err := SniffContentType(bytes.NewReader(body))
	if err != nil {
		t.Fatalf("err on short file: %v", err)
	}
	if mime == "" {
		t.Errorf("empty MIME on short file")
	}
	// Replay must yield exactly the 4 bytes.
	out, _ := io.ReadAll(replay)
	if !bytes.Equal(out, body) {
		t.Errorf("replay = %v, want %v", out, body)
	}
}

func TestSniffAndValidate_acceptsAllowed(t *testing.T) {
	allow := map[string]bool{"image/png": true}
	mime, _, err := SniffAndValidate(bytes.NewReader(pngMagic), "image/png", allow)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if mime != "image/png" {
		t.Errorf("mime = %q", mime)
	}
}

func TestSniffAndValidate_rejectsDisallowedWithTypedError(t *testing.T) {
	allow := map[string]bool{"image/png": true}
	// Claim png but ship pdf bytes — classic mismatch.
	_, _, err := SniffAndValidate(bytes.NewReader(pdfMagic), "image/png", allow)
	var mimeErr *MIMETypeError
	if !errors.As(err, &mimeErr) {
		t.Fatalf("want *MIMETypeError, got %T: %v", err, err)
	}
	if mimeErr.Detected != "application/pdf" {
		t.Errorf("Detected = %q", mimeErr.Detected)
	}
	if mimeErr.Claimed != "image/png" {
		t.Errorf("Claimed = %q", mimeErr.Claimed)
	}
	if !strings.Contains(mimeErr.Error(), "declared image/png but bytes are application/pdf") {
		t.Errorf("error text lacks mismatch clue: %q", mimeErr.Error())
	}
}

func TestSniffOrExtension_recoversOggByExtension(t *testing.T) {
	// Sniff yields "application/ogg" (per http.DetectContentType), which
	// isn't in our allowlist even though "audio/ogg" is. Extension "ogg"
	// resolves the mismatch — this is the real-world fix.
	allow := map[string]bool{"audio/ogg": true}
	mime, _, err := SniffOrExtension(bytes.NewReader(oggMagic), "song.ogg", "audio/ogg", allow)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if mime != "audio/ogg" {
		t.Errorf("mime = %q, want audio/ogg", mime)
	}
}

func TestSniffOrExtension_recoversOctetStreamByExtension(t *testing.T) {
	// Bytes that DetectContentType can't classify → application/octet-stream.
	// Extension .txt → text/plain is in allowlist → accepted.
	blob := []byte{0x00, 0x01, 0x02, 0x03, 0x04}
	allow := map[string]bool{"text/plain": true}
	mime, _, err := SniffOrExtension(bytes.NewReader(blob), "notes.txt", "text/plain", allow)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if mime != "text/plain" {
		t.Errorf("mime = %q, want text/plain", mime)
	}
}

func TestSniffOrExtension_rejectsWhenBothMiss(t *testing.T) {
	// Neither the bytes NOR the extension resolve to an allowed type.
	allow := map[string]bool{"image/png": true}
	_, _, err := SniffOrExtension(bytes.NewReader(pdfMagic), "shell.exe", "image/png", allow)
	var mimeErr *MIMETypeError
	if !errors.As(err, &mimeErr) {
		t.Fatalf("want *MIMETypeError, got %v", err)
	}
	// Detected is what the bytes actually looked like, not the extension guess.
	if mimeErr.Detected != "application/pdf" {
		t.Errorf("Detected = %q", mimeErr.Detected)
	}
}

func TestSniffOrExtension_prefersSniffOverExtensionWhenBothInAllowlist(t *testing.T) {
	// Bytes ARE png, filename says .txt. Both mime types are in the
	// allowlist. Sniff wins — the bytes are the source of truth.
	allow := map[string]bool{"image/png": true, "text/plain": true}
	mime, _, err := SniffOrExtension(bytes.NewReader(pngMagic), "confusing.txt", "image/png", allow)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if mime != "image/png" {
		t.Errorf("mime = %q, want image/png (bytes take priority)", mime)
	}
}

func TestSniffOrExtension_extensionIsCaseInsensitive(t *testing.T) {
	allow := map[string]bool{"audio/ogg": true}
	mime, _, err := SniffOrExtension(bytes.NewReader(oggMagic), "SONG.OGG", "audio/ogg", allow)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if mime != "audio/ogg" {
		t.Errorf("mime = %q, want audio/ogg", mime)
	}
}
