package services

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

const maxMusicMetadataBytes = 4 << 20

var youtubeVideoID = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)
var errMusicMetadataTooLarge = errors.New("music metadata exceeds size limit")

// A queue cap alone does not bound extraction: a playlist can emit thousands
// of full JSON blobs before Enqueue truncates it. Bound both the subprocess's
// requested entries and the bytes copied into memory.
type musicMetadataBuffer struct {
	buf      bytes.Buffer
	overflow bool
}

func (b *musicMetadataBuffer) Write(p []byte) (int, error) {
	if len(p) > maxMusicMetadataBytes-b.buf.Len() {
		b.overflow = true
		return 0, errMusicMetadataTooLarge
	}
	return b.buf.Write(p)
}

// ytDlpPath resolves the yt-dlp binary to an absolute path once, instead of
// letting exec walk $PATH on every invocation.
//
// Two reasons. Passing a bare name means the lookup is repeated per call and
// can resolve differently over the process's lifetime; this container runs as
// root (no active USER in the Dockerfile), so a write primitive into any
// directory on PATH would be a root-level code-execution path. Resolving once
// also turns "yt-dlp isn't installed" into a single clear error rather than a
// surprise on whichever /play happens to be first.
//
// The production image installs it at /usr/local/bin/yt-dlp, checksum-pinned;
// LookPath is kept rather than hardcoding that so self-hosted and local dev
// installs keep working. ffmpegPath uses the same cached resolution for the
// audio conversion pipeline.
var ytDlpPath = sync.OnceValues(func() (string, error) {
	return exec.LookPath("yt-dlp")
})

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
//	--print            only the metadata fields needed for each track
//	--no-warnings       suppress noisy warnings on private/age-restricted videos
//	--ignore-errors     tolerate single-video failures inside a playlist
//	--use-extractors "Youtube.*"  restrict resolution to yt-dlp's dedicated
//	                    YouTube extractors. Without it, a URL that no
//	                    YouTube-specific extractor claims (even one whose host
//	                    and path both pass validateMusicURLNetwork) falls
//	                    through to yt-dlp's GenericIE, which fetches the page
//	                    itself and can follow redirects/embeds to an
//	                    attacker-controlled host — see music_url_guard.go's
//	                    doc comment. With the flag, an unclaimed URL fails
//	                    with "No suitable extractor found" and yt-dlp never
//	                    makes a network request for it.
//
// The subprocess sees at most maxQueueLen+1 entries; output is additionally
// byte-bounded. 30s context timeout — playlist resolution never takes minutes.
func extractTracks(parent context.Context, urlStr, requesterID, requesterName string) ([]models.MusicTrack, error) {
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()

	if err := validateMusicURLNetwork(ctx, urlStr); err != nil {
		return nil, err
	}

	// `--` terminates yt-dlp's option parsing. Without it, a caller-supplied
	// `url` like `--exec "wget ..."` would be interpreted as a yt-dlp flag
	// (argument injection → RCE under the server process). Handlers also
	// allow-list the URL scheme, but this is the defense-in-depth layer
	// closest to the actual subprocess.
	bin, err := ytDlpPath()
	if err != nil {
		return nil, fmt.Errorf("%w: yt-dlp not available: %w", errToolMissing, err)
	}
	cmd := exec.CommandContext(ctx, bin, extractTracksArgs(urlStr)...) // #nosec G204 -- urlStr is user-supplied, but bin is an absolute path resolved once by ytDlpPath, exec.CommandContext never invokes a shell (no metacharacter-injection vector), validateMusicURLNetwork above enforces a host allow-list (SSRF's primary control here — see music_url_guard.go doc comment) plus a post-DNS private/reserved-IP check, and "--" in extractTracksArgs stops urlStr from being parsed as a yt-dlp flag
	stdout := &musicMetadataBuffer{}
	stderr := newTailBuffer(ytDlpStderrTailBytes)
	cmd.Stdout, cmd.Stderr = stdout, stderr
	cmd.WaitDelay = subprocessWaitDelay
	runErr := cmd.Run()
	// A cancelled request must not enqueue partially extracted tracks after
	// the caller has left. Keep deadlines classifiable as network failures.
	if ctx.Err() != nil {
		return nil, fmt.Errorf("music extraction interrupted: %w", ctx.Err())
	}
	if stdout.overflow {
		return nil, errMusicMetadataTooLarge
	}
	out, err := parseMusicMetadata(bytes.NewReader(stdout.buf.Bytes()), requesterID, requesterName)
	if err != nil {
		return nil, err
	}
	// A playlist may contain unavailable entries. Keep valid entries on a
	// partial exit, but preserve classified errors if nothing can play.
	if len(out) == 0 && runErr != nil {
		return nil, &trackPlaybackError{
			Reason: classifyPlaybackFailure(runErr, stderr.String()),
			err:    fmt.Errorf("yt-dlp metadata failed: %w", runErr),
		}
	}
	if len(out) == 0 {
		return nil, &trackPlaybackError{Reason: reasonUnavailable, err: errors.New("no playable YouTube videos found")}
	}
	return out, nil
}

func parseMusicMetadata(r io.Reader, requesterID, requesterName string) ([]models.MusicTrack, error) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 4096), 256<<10)
	out := make([]models.MusicTrack, 0)
	for scanner.Scan() {
		var raw ytdlpEntry
		if json.Unmarshal(scanner.Bytes(), &raw) != nil {
			continue
		}
		track := raw.toTrack("", requesterID, requesterName)
		if track.VideoID == "" {
			continue
		}
		out = append(out, track)
		if len(out) == maxQueueLen+1 {
			break
		}
	}
	return out, scanner.Err()
}

// extractTracksArgs builds extractTracks's yt-dlp argv. Factored out (rather
// than inlined at the exec.CommandContext call) so a test can assert
// "--use-extractors Youtube.*" is actually present without spawning the
// subprocess — see TestExtractTracksArgs_RestrictsToYoutubeExtractors.
func extractTracksArgs(urlStr string) []string {
	return []string{
		"--ignore-config",
		"--no-plugin-dirs",
		"--no-remote-components",
		"--flat-playlist",
		"--lazy-playlist",
		"--playlist-end", strconv.Itoa(maxQueueLen + 1),
		"--skip-download",
		"--print", "%(.{id,title,uploader,channel,duration,thumbnail})j",
		"--no-warnings",
		"--ignore-errors",
		"--socket-timeout", "10",
		"--extractor-retries", "1",
		"--use-extractors", "Youtube.*",
		"--",
		urlStr,
	}
}

// SearchMusicTracks resolves a bounded YouTube name search without accepting
// a caller-controlled URL. The query remains one argv value after `--`; no
// shell is involved and yt-dlp is restricted to YouTube extractors.
func SearchMusicTracks(parent context.Context, query string) ([]models.MusicTrack, error) {
	query = strings.TrimSpace(query)
	if query == "" || len([]rune(query)) > 100 || strings.ContainsAny(query, "\x00\r\n") {
		return nil, fmt.Errorf("%w: search query must be 1-100 characters", pkg.ErrBadRequest)
	}
	ctx, cancel := context.WithTimeout(parent, 20*time.Second)
	defer cancel()
	bin, err := ytDlpPath()
	if err != nil {
		return nil, fmt.Errorf("%w: yt-dlp not available: %w", errToolMissing, err)
	}
	cmd := exec.CommandContext(ctx, bin, searchMusicArgs(query)...) // #nosec G204 -- fixed binary, no shell, bounded query is a single argv value after --
	stdout := &musicMetadataBuffer{}
	stderr := newTailBuffer(ytDlpStderrTailBytes)
	cmd.Stdout, cmd.Stderr = stdout, stderr
	cmd.WaitDelay = subprocessWaitDelay
	runErr := cmd.Run()
	if ctx.Err() != nil {
		return nil, fmt.Errorf("music search interrupted: %w", ctx.Err())
	}
	if stdout.overflow {
		return nil, errMusicMetadataTooLarge
	}
	tracks, err := parseMusicMetadata(bytes.NewReader(stdout.buf.Bytes()), "", "")
	if err != nil {
		return nil, err
	}
	if len(tracks) > 5 {
		tracks = tracks[:5]
	}
	if len(tracks) == 0 {
		return nil, &trackPlaybackError{Reason: classifyPlaybackFailure(runErr, stderr.String()), err: errors.New("no YouTube search results")}
	}
	return tracks, nil
}

func searchMusicArgs(query string) []string {
	return []string{
		"--ignore-config", "--no-plugin-dirs", "--no-remote-components",
		"--flat-playlist", "--playlist-end", "5", "--skip-download",
		"--print", "%(.{id,title,uploader,channel,duration,thumbnail})j",
		"--no-warnings", "--socket-timeout", "10", "--extractor-retries", "1",
		"--use-extractors", "Youtube.*", "--", "ytsearch5:" + query,
	}
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

func (r ytdlpEntry) toTrack(_ string, requesterID, requesterName string) models.MusicTrack {
	// Never feed a playlist, transient CDN URL, or arbitrary extractor output
	// back into the download subprocess. A queue entry is exactly one video.
	if !youtubeVideoID.MatchString(r.ID) {
		return models.MusicTrack{}
	}
	artist := r.Uploader
	if artist == "" {
		artist = r.Channel
	}
	title := strings.TrimSpace(r.Title)
	if title == "" {
		title = r.ID
	}
	duration := 0
	if r.Duration > 0 && r.Duration < float64(math.MaxInt) && !math.IsInf(r.Duration, 0) {
		duration = int(r.Duration)
	}
	return models.MusicTrack{
		VideoID:           r.ID,
		Title:             truncateRunes(title, 300),
		Artist:            truncateRunes(artist, 200),
		Thumbnail:         "https://i.ytimg.com/vi/" + r.ID + "/hqdefault.jpg",
		DurationSeconds:   duration,
		URL:               "https://www.youtube.com/watch?v=" + r.ID,
		RequestedByUserID: requesterID,
		RequestedByName:   requesterName,
	}
}
