package services

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/argeinfina/hichat/models"
)

// extractTracks — call yt-dlp to resolve a URL into one or more tracks.
//
// Single video URL → one track. Playlist URL → N tracks (one per video).
// Each track gets the same RequestedBy fields. Metadata fetched here is
// cheap (no audio extraction, no download); the actual stream URL is
// re-extracted at play time via the same binary because YouTube's signed
// CDN links expire within a few hours.
//
// yt-dlp invocation:
//
//	--flat-playlist     emit one entry per video without descending into formats
//	--dump-json         JSON-per-line output
//	--no-warnings       suppress noisy warnings on private/age-restricted videos
//	--ignore-errors     tolerate single-video failures inside a playlist
//
// 30s context timeout — playlist resolution can be slow but never minutes.
func extractTracks(parent context.Context, urlStr, requesterID, requesterName string) ([]models.MusicTrack, error) {
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()

	if !strings.HasPrefix(urlStr, "http://") && !strings.HasPrefix(urlStr, "https://") {
		return nil, fmt.Errorf("invalid URL scheme: only http and https are allowed")
	}

	// `--` terminates yt-dlp's option parsing. Without it, a caller-supplied
	// `url` like `--exec "wget ..."` would be interpreted as a yt-dlp flag
	// (argument injection → RCE under the server process). Handlers also
	// allow-list the URL scheme, but this is the defense-in-depth layer
	// closest to the actual subprocess.
	cmd := exec.CommandContext(ctx,
		"yt-dlp",
		"--flat-playlist",
		"--dump-json",
		"--no-warnings",
		"--ignore-errors",
		"--",
		url,
	)
	stdout, err := cmd.Output()
	if err != nil {
		// yt-dlp returns non-zero on partial playlist failures even when
		// some entries succeeded; keep going if we got any JSON lines.
		if len(stdout) == 0 {
			return nil, fmt.Errorf("yt-dlp exited %v", err)
		}
	}

	var out []models.MusicTrack
	for _, line := range strings.Split(string(stdout), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var raw ytdlpEntry
		if jerr := json.Unmarshal([]byte(line), &raw); jerr != nil {
			continue
		}
		track := raw.toTrack(url, requesterID, requesterName)
		if track.VideoID == "" {
			continue
		}
		out = append(out, track)
	}
	return out, nil
}

// ytdlpEntry — slice of yt-dlp JSON we care about. yt-dlp emits a huge
// metadata blob; we only deserialise these fields. Note `Duration` is a
// float64 because yt-dlp uses fractional seconds for some sources.
type ytdlpEntry struct {
	ID          string  `json:"id"`
	Title       string  `json:"title"`
	Uploader    string  `json:"uploader"`
	Channel     string  `json:"channel"`
	Duration    float64 `json:"duration"`
	Thumbnail   string  `json:"thumbnail"`
	WebpageURL  string  `json:"webpage_url"`
	OriginalURL string  `json:"original_url"`
	URL         string  `json:"url"` // for flat-playlist entries
}

func (r ytdlpEntry) toTrack(originalUserURL, requesterID, requesterName string) models.MusicTrack {
	artist := r.Uploader
	if artist == "" {
		artist = r.Channel
	}
	// Prefer a per-entry URL when this came from a playlist; fall back to
	// the user's original URL for single-video inputs.
	resolvedURL := r.WebpageURL
	if resolvedURL == "" {
		resolvedURL = r.OriginalURL
	}
	if resolvedURL == "" {
		resolvedURL = r.URL
	}
	if resolvedURL == "" {
		resolvedURL = originalUserURL
	}
	thumb := r.Thumbnail
	if thumb == "" && r.ID != "" {
		// Standard YouTube thumbnail fallback (always works for public videos).
		thumb = "https://i.ytimg.com/vi/" + r.ID + "/hqdefault.jpg"
	}
	return models.MusicTrack{
		VideoID:           r.ID,
		Title:             r.Title,
		Artist:            artist,
		Thumbnail:         thumb,
		DurationSeconds:   int(r.Duration),
		URL:               resolvedURL,
		RequestedByUserID: requesterID,
		RequestedByName:   requesterName,
	}
}
