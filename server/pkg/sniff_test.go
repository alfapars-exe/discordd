package pkg

import (
	"bytes"
	"io"
	"testing"
)

// Minimal magic-byte prefixes recognized by http.DetectContentType.
var (
	pngMagic  = []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}
	jpegMagic = []byte{0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 'J', 'F', 'I', 'F'}
	gifMagic  = []byte("GIF89a")
	pdfMagic  = []byte("%PDF-1.4\n")
	// http.DetectContentType returns "application/ogg" for OGG containers,
	// not "audio/ogg" — RefineMIME's extension fallback is what records the
	// audio type for ogg uploads.
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
		// The raw sniff for an OGG container is the generic
		// "application/ogg" — RefineMIME (tested separately below) is
		// what upgrades this to "audio/ogg" via the extension fallback.
		{"ogg", oggMagic, "application/ogg"},
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

func TestRefineMIME(t *testing.T) {
	tests := []struct {
		name     string
		sniffed  string
		filename string
		want     string
	}{
		// The two generic results ARE refined by extension.
		{"ogg container to audio", "application/ogg", "song.ogg", "audio/ogg"},
		{"octet-stream txt", "application/octet-stream", "notes.txt", "text/plain"},
		{"octet-stream mp3", "application/octet-stream", "track.mp3", "audio/mpeg"},
		{"octet-stream avif", "application/octet-stream", "pic.avif", "image/avif"},
		{"extension is case-insensitive", "application/octet-stream", "SONG.OGG", "audio/ogg"},
		// No extension match → generic result stays.
		{"unknown extension stays generic", "application/octet-stream", "shell.exe", "application/octet-stream"},
		{"no extension stays generic", "application/octet-stream", "blob", "application/octet-stream"},
		// A SPECIFIC sniff is never overridden by the name — bytes win.
		// This is the security property: HTML disguised as .png must keep
		// its text/html classification for the serve-time decision.
		{"specific sniff beats png name", "text/html", "fake.png", "text/html"},
		{"specific sniff beats txt name", "image/png", "confusing.txt", "image/png"},
		// svg is deliberately NOT in the map — an octet-stream sniff with an
		// .svg name must stay generic (never classified inline-displayable).
		{"svg never refined", "application/octet-stream", "pic.svg", "application/octet-stream"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := RefineMIME(tc.sniffed, tc.filename); got != tc.want {
				t.Errorf("RefineMIME(%q, %q) = %q, want %q", tc.sniffed, tc.filename, got, tc.want)
			}
		})
	}
}

func TestNormalizeMIME(t *testing.T) {
	if got := NormalizeMIME("Text/Plain; charset=utf-8"); got != "text/plain" {
		t.Errorf("NormalizeMIME = %q, want text/plain", got)
	}
	if got := NormalizeMIME("image/png"); got != "image/png" {
		t.Errorf("NormalizeMIME = %q, want image/png", got)
	}
}
