package handlers_test

// External test package on purpose: this test needs the real
// middleware.RequestLogger, and middleware imports handlers, so an
// in-package (package handlers) test importing middleware would be an
// import cycle.

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/handlers"
	"github.com/argeinfina/hichat/middleware"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/services"
)

// slowEnqueueMusicService's Enqueue outlives the test server's WriteTimeout,
// the way a slow yt-dlp extraction plus a channel's first LiveKit connect
// does in production.
type slowEnqueueMusicService struct {
	delay time.Duration
}

func (s *slowEnqueueMusicService) Enqueue(_ context.Context, _, _, _ string) ([]models.MusicTrack, error) {
	time.Sleep(s.delay)
	return []models.MusicTrack{{VideoID: "v1", Title: "Track"}}, nil
}
func (s *slowEnqueueMusicService) Skip(string) error                            { return nil }
func (s *slowEnqueueMusicService) Pause(string) error                           { return nil }
func (s *slowEnqueueMusicService) Resume(string) error                          { return nil }
func (s *slowEnqueueMusicService) Stop(string) error                            { return nil }
func (s *slowEnqueueMusicService) GetState(string) *models.MusicBotChannelState { return nil }
func (s *slowEnqueueMusicService) StopAllForChannel(string)                     {}

// allowAllPerms grants everything — the permission gate is not under test.
type allowAllPerms struct{}

func (allowAllPerms) ResolveChannelPermissions(_ context.Context, _, _ string) (models.Permission, error) {
	return models.PermAll, nil
}

func (allowAllPerms) ResolveChannelPermissionsBulk(_ context.Context, _ string, userIDs []string) (map[string]models.Permission, error) {
	out := make(map[string]models.Permission, len(userIDs))
	for _, id := range userIDs {
		out[id] = models.PermAll
	}
	return out, nil
}

var (
	_ services.MusicBotService     = (*slowEnqueueMusicService)(nil)
	_ services.ChannelPermResolver = allowAllPerms{}
)

// TestPlay_SurvivesServerWriteTimeout — Play extends its own write deadline
// so a slow Enqueue does not lose the response to the server-wide
// WriteTimeout (the track used to be queued while the client saw a dropped
// connection). Runs through a real server and the real RequestLogger,
// because the deadline only reaches the connection through
// statusRecorder.Unwrap; httptest.ResponseRecorder cannot test this.
func TestPlay_SurvivesServerWriteTimeout(t *testing.T) {
	h := handlers.NewMusicHandler(&slowEnqueueMusicService{delay: 300 * time.Millisecond}, allowAllPerms{}, nil)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/servers/{serverId}/channels/{channelId}/music/play", func(w http.ResponseWriter, r *http.Request) {
		user := &models.User{ID: "user-1", Username: "tester"}
		h.Play(w, r.WithContext(context.WithValue(r.Context(), handlers.UserContextKey, user)))
	})
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewUnstartedServer(middleware.RequestLogger(logger, nil)(mux))
	srv.Config.WriteTimeout = 100 * time.Millisecond
	srv.Start()
	defer srv.Close()

	resp, err := srv.Client().Post(srv.URL+"/api/servers/srv/channels/ch/music/play", "application/json",
		strings.NewReader(`{"url":"https://www.youtube.com/watch?v=x"}`))
	if err != nil {
		t.Fatalf("POST /music/play failed (response lost to the write timeout?): %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	var body struct {
		Success bool `json:"success"`
		Data    struct {
			AddedTracks []models.MusicTrack `json:"added_tracks"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("response is not valid JSON: %v", err)
	}
	if !body.Success || len(body.Data.AddedTracks) != 1 {
		t.Fatalf("body = %+v, want success with 1 added track", body)
	}
}
