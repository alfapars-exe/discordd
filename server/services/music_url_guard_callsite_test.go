package services

// Call-site tests for the music SSRF guard.
//
// music_url_guard_test.go proves validateMusicURL* behaves correctly. These
// prove the two yt-dlp call sites actually *invoke* it — a distinction that
// matters, because deleting either call leaves the guard fully tested and the
// server fully exploitable. Without these, both call sites are protected only
// by a grep in a review checklist.
//
// Both tests assert the returned error is pkg.ErrBadRequest specifically, not
// merely non-nil. That is what makes them mutation-sensitive: with the guard
// in place the rejection is ErrBadRequest; with it removed, execution reaches
// exec.CommandContext and whatever comes back (yt-dlp missing, non-zero exit,
// network failure) is a different error, so errors.Is fails and the test goes
// red. They also never spawn a subprocess in the passing case, so they stay
// fast and hermetic.

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func TestExtractTracks_RejectsDisallowedHostBeforeSpawning(t *testing.T) {
	for _, raw := range []string{
		"http://169.254.169.254/latest/meta-data/",
		"http://127.0.0.1:8080/",
		"https://evil.example/watch?v=x",
	} {
		t.Run(raw, func(t *testing.T) {
			tracks, err := extractTracks(context.Background(), raw, "user-1", "Requester")
			if !errors.Is(err, pkg.ErrBadRequest) {
				t.Fatalf("extractTracks(%q) must reject with pkg.ErrBadRequest before spawning yt-dlp; got err=%v", raw, err)
			}
			if tracks != nil {
				t.Fatalf("extractTracks(%q) returned %d tracks alongside a rejection", raw, len(tracks))
			}
		})
	}
}

func TestPlayTrack_RejectsDisallowedHostBeforeSpawning(t *testing.T) {
	// track.URL reaches playTrack from toTrack's fallback chain — yt-dlp's own
	// JSON output — so it is not covered by the handler's edge validation and
	// needs this call site's own guard.
	for _, raw := range []string{
		"http://169.254.169.254/latest/meta-data/",
		"https://evil.example/watch?v=x",
	} {
		t.Run(raw, func(t *testing.T) {
			svc := &musicBotService{}
			bot := &botInstance{channelID: "channel-1"}
			track := &models.MusicTrack{VideoID: "vid", Title: "title", URL: raw}

			err := svc.playTrack(bot, track)
			if !errors.Is(err, pkg.ErrBadRequest) {
				t.Fatalf("playTrack(track.URL=%q) must reject with pkg.ErrBadRequest before spawning yt-dlp; got err=%v", raw, err)
			}
		})
	}
}
