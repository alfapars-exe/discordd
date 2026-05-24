package services

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/argeinfina/hichat/models"
)

// ytdlpExtractorArgs — multi-client probe order. YouTube serves
// bot-challenges per client; some are more aggressive than others.
// Listed mobile-first because mobile clients tend to slip past
// data-center IP filters that hit the desktop `web` client.
//
// Order matters: yt-dlp tries left-to-right and stops at the first
// client that produces formats. Mobile web (`mweb`) is checked first
// because it returns the largest format catalog when it works at all.
// `tv_embedded` is the most permissive on age-gated / region-locked
// content. `android` and `ios` are the official-app flows — heavier
// signature requirements but sometimes still pass when web variants
// fail. `default` is left at the end as a last-resort.
//
// This list will rot — YouTube swaps which clients trip the challenge
// every few weeks. When playback breaks again, reordering or
// substituting client names here is the first thing to try.
//
// Reference: https://github.com/yt-dlp/yt-dlp/wiki/Extractors#youtube
const ytdlpExtractorArgs = "youtube:player_client=mweb,tv_embedded,android,ios,web_safari,default"

// ytdlpUserAgent — a real-looking mobile Safari User-Agent. yt-dlp's
// default UA includes "yt-dlp/<version>" and is increasingly an
// instant red flag for YouTube's bot detection. Overriding to a
// genuine browser string buys some additional plausibility before the
// challenge fires. Pair with ytdlpExtractorArgs above for best odds.
const ytdlpUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"

// ytdlpAuthFlags — read once per invocation from the YTDLP_COOKIES_PATH
// env var. When YouTube's bot challenge fires on data-center IPs (the
// "Sign in to confirm you're not a bot" message), the only durable
// bypass is to pass a real signed-in cookies jar via --cookies.
//
// Set YTDLP_COOKIES_PATH in HF Space → Settings → Repository Secrets to
// a file path inside /data (persisted across container restarts). The
// file must be Netscape-format cookies exported from a logged-in
// YouTube session — `yt-dlp --cookies-from-browser firefox --cookies
// /tmp/cookies.txt --simulate <any_url>` on a local machine is the
// easiest way to produce one.
//
// When the env var is unset, we omit the flag entirely so anonymous
// (non-bot-challenged) installs keep working without setup.
func ytdlpAuthFlags() []string {
	path := strings.TrimSpace(os.Getenv("YTDLP_COOKIES_PATH"))
	if path == "" {
		return nil
	}
	if _, err := os.Stat(path); err != nil {
		// Path was configured but the file isn't readable (typo, not
		// uploaded, wrong permissions). Skip the flag rather than
		// erroring — yt-dlp would crash with "unable to open cookie
		// file" and that's a worse failure than the bot challenge.
		return nil
	}
	return []string{"--cookies", path}
}

// normalizeYouTubeURL — strip Mix/Radio params that confuse yt-dlp's
// --flat-playlist mode. YouTube Mix URLs (`list=RD…`) are dynamically
// generated — the N+1th video is materialized only while a real client
// watches the Nth — so yt-dlp cannot enumerate them ahead of time and
// typically returns 0 entries with `Unable to extract playlist`. We
// strip the dynamic-playlist params and pass the seed video on its own,
// which is also the most predictable behavior when a user shares a Mix
// from YouTube's "Watch Later → Play" menu.
//
// Also drops tracking params (`pp`, `si`) that yt-dlp never needs and
// that occasionally cause cache-key drift between metadata and stream
// extraction passes.
//
// Real playlists (`list=PL…`, `list=UU…`, `list=OL…`) are left intact so
// the existing --flat-playlist multi-track flow still works.
func normalizeYouTubeURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	host := strings.ToLower(u.Host)
	isYT := host == "www.youtube.com" ||
		host == "youtube.com" ||
		host == "m.youtube.com" ||
		host == "music.youtube.com" ||
		host == "youtu.be"
	if !isYT {
		return raw
	}
	q := u.Query()
	if listID := q.Get("list"); strings.HasPrefix(listID, "RD") {
		q.Del("list")
		q.Del("start_radio")
		q.Del("index")
	}
	q.Del("pp")
	q.Del("si")
	u.RawQuery = q.Encode()
	return u.String()
}

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
func extractTracks(parent context.Context, rawURL, requesterID, requesterName string) ([]models.MusicTrack, error) {
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()

	// Mix/Radio URLs cannot be flat-enumerated; normalize before invoking yt-dlp
	// so the user gets the seed video instead of 0 entries.
	cleanURL := normalizeYouTubeURL(rawURL)

	args := []string{
		"--flat-playlist",
		"--dump-json",
		"--no-warnings",
		"--ignore-errors",
		"--extractor-args", ytdlpExtractorArgs,
		"--user-agent", ytdlpUserAgent,
		"--geo-bypass",
	}
	args = append(args, ytdlpAuthFlags()...)
	args = append(args, cleanURL)
	cmd := exec.CommandContext(ctx, "yt-dlp", args...)
	// Capture stderr separately so a non-zero exit can be reported with its
	// actual reason ("ERROR: Sign in to confirm…", "Video unavailable", etc.)
	// instead of the bare "exit status 1". Without this the user toast was
	// "yt-dlp extraction failed: yt-dlp exited exit status 1" — informative
	// to nobody.
	var stderrBuf bytes.Buffer
	cmd.Stderr = &stderrBuf
	stdout, err := cmd.Output()
	if err != nil {
		// yt-dlp returns non-zero on partial playlist failures even when
		// some entries succeeded; keep going if we got any JSON lines.
		if len(stdout) == 0 {
			reason := lastErrorLine(stderrBuf.String())
			if reason != "" {
				return nil, fmt.Errorf("yt-dlp exited %v: %s", err, reason)
			}
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
		track := raw.toTrack(cleanURL, requesterID, requesterName)
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
