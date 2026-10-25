package services

// Opt-in live acceptance for the YouTube name-search path. This test uses the
// same explicitly loopback-only LiveKit contract as the playback smoke test,
// but does not duplicate its long media/decryption assertions.
import (
	"context"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg/crypto"
	"github.com/argeinfina/hichat/testutil"
)

const musicSearchSmokeUserID = "music-search-smoke-requester"

func TestSelectMusicSearchSmokeResultUsesExactCanonicalVideo(t *testing.T) {
	wantID := "dQw4w9WgXcQ"
	tracks := []models.MusicTrack{
		{VideoID: "aaaaaaaaaaa", Title: "other", URL: "https://www.youtube.com/watch?v=aaaaaaaaaaa"},
		{VideoID: wantID, Title: "target", URL: "https://www.youtube.com/watch?v=" + wantID},
	}
	selected, ok := selectMusicSearchSmokeResult(tracks, wantID)
	if !ok || selected.Title != "target" {
		t.Fatalf("selected=%+v, ok=%v; want exact target", selected, ok)
	}
	if _, ok := selectMusicSearchSmokeResult(tracks, "bbbbbbbbbbb"); ok {
		t.Fatal("must not silently fall back to a different search result")
	}
	tracks[1].URL = "https://example.invalid/watch?v=" + wantID
	if _, ok := selectMusicSearchSmokeResult(tracks, wantID); ok {
		t.Fatal("must reject non-canonical selected result URLs")
	}
}

func selectMusicSearchSmokeResult(tracks []models.MusicTrack, expectedVideoID string) (models.MusicTrack, bool) {
	if !youtubeVideoID.MatchString(expectedVideoID) {
		return models.MusicTrack{}, false
	}
	wantURL := "https://www.youtube.com/watch?v=" + expectedVideoID
	for _, track := range tracks {
		if track.VideoID == expectedVideoID && track.URL == wantURL && strings.TrimSpace(track.Title) != "" {
			return track, true
		}
	}
	return models.MusicTrack{}, false
}

func TestMusicYouTubeSearchLiveAcceptance(t *testing.T) {
	smokeURL := strings.TrimSpace(os.Getenv("MUSIC_YOUTUBE_SMOKE_URL"))
	livekitURL := strings.TrimSpace(os.Getenv("MUSIC_LIVEKIT_SMOKE_URL"))
	if smokeURL == "" || livekitURL == "" {
		t.Skip("set MUSIC_YOUTUBE_SMOKE_URL and MUSIC_LIVEKIT_SMOKE_URL to opt in; LiveKit must be disposable and loopback")
	}
	parsedLK, err := url.Parse(livekitURL)
	if err != nil || (parsedLK.Hostname() != "127.0.0.1" && parsedLK.Hostname() != "localhost" && parsedLK.Hostname() != "::1") {
		t.Fatal("search smoke requires the existing disposable loopback LiveKit contract; refusing non-loopback URL")
	}
	expectedVideoID, err := youtubeVideoIDFromURL(smokeURL)
	if err != nil {
		t.Fatalf("MUSIC_YOUTUBE_SMOKE_URL must identify one YouTube video: %v", err)
	}
	for _, tool := range []string{"yt-dlp", "deno", "ffmpeg"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("live search/enqueue acceptance requires %s on PATH", tool)
		}
	}

	query := strings.TrimSpace(os.Getenv("MUSIC_YOUTUBE_SEARCH_QUERY"))
	if query == "" {
		query = "Ouz BENDE"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	results, err := SearchMusicTracks(ctx, query)
	if err != nil {
		t.Fatalf("live YouTube search %q failed: %v", query, err)
	}
	selected, ok := selectMusicSearchSmokeResult(results, expectedVideoID)
	if !ok {
		var got []string
		for _, result := range results {
			got = append(got, fmt.Sprintf("%q (%s)", result.Title, result.VideoID))
		}
		t.Fatalf("search %q did not return configured smoke video %s; results: %s", query, expectedVideoID, strings.Join(got, ", "))
	}

	channelID := fmt.Sprintf("music-search-smoke-%d", time.Now().UnixNano())
	const serverID = "integration"
	key := []byte("01234567890123456789012345678901")
	apiKey, err := crypto.Encrypt("devkey", key)
	if err != nil {
		t.Fatal(err)
	}
	apiSecret, err := crypto.Encrypt("secret", key)
	if err != nil {
		t.Fatal(err)
	}
	lk := &mockConfigurableLiveKitGetter{GetByServerIDFn: func(context.Context, string) (*models.LiveKitInstance, error) {
		return &models.LiveKitInstance{URL: livekitURL, APIKey: apiKey, APISecret: apiSecret}, nil
	}}
	svc := NewMusicBotService(
		&stubChannelGetter{channel: &models.Channel{ID: channelID, ServerID: serverID, Type: models.ChannelTypeVoice}},
		lk, nil, &testutil.MockBroadcaster{}, stubMusicUserGetter{}, key, nil, nil,
		staticMusicRoomKey{passphrase: "music-live-smoke"},
	)
	defer svc.Stop(channelID)
	enqueued, err := svc.Enqueue(ctx, musicSearchSmokeUserID, channelID, selected.URL)
	if err != nil {
		t.Fatalf("enqueue selected canonical search result: %v", err)
	}
	if len(enqueued) != 1 {
		t.Fatalf("enqueue returned %d tracks, want one selected video", len(enqueued))
	}
	track := enqueued[0]
	if track.VideoID != expectedVideoID || track.URL != "https://www.youtube.com/watch?v="+expectedVideoID {
		t.Fatalf("enqueue changed selected identity/canonical URL: %+v", track)
	}
	if track.RequestedByUserID != musicSearchSmokeUserID || track.RequestedByName != musicSearchSmokeUserID {
		t.Fatalf("enqueue lost requester identity: ID=%q name=%q", track.RequestedByUserID, track.RequestedByName)
	}
	t.Logf("query %q selected %q (%s); canonical enqueue retained requester %s", query, selected.Title, selected.VideoID, track.RequestedByUserID)
}

func youtubeVideoIDFromURL(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u == nil {
		return "", fmt.Errorf("invalid URL")
	}
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	if host != "youtube.com" && host != "www.youtube.com" && host != "m.youtube.com" && host != "youtu.be" && host != "www.youtube-nocookie.com" {
		return "", fmt.Errorf("host is not a supported YouTube host")
	}
	var videoID string
	switch {
	case host == "youtu.be":
		videoID = strings.TrimPrefix(path.Clean(u.Path), "/")
	case u.Path == "/watch":
		videoID = u.Query().Get("v")
	case strings.HasPrefix(u.Path, "/shorts/"):
		videoID = strings.TrimPrefix(strings.TrimPrefix(u.Path, "/shorts/"), "/")
	case strings.HasPrefix(u.Path, "/embed/"):
		videoID = strings.TrimPrefix(strings.TrimPrefix(u.Path, "/embed/"), "/")
	}
	if !youtubeVideoID.MatchString(videoID) {
		return "", fmt.Errorf("URL does not contain a valid video ID")
	}
	return videoID, nil
}
