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
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

const maxMusicMetadataBytes = 4 << 20
const maxMusicMetadataDiagnosticRunes = 1280

var youtubeVideoID = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)
var errMusicMetadataTooLarge = errors.New("music metadata exceeds size limit")
var musicDiagnosticANSI = regexp.MustCompile(`\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]`)
var musicDiagnosticURL = regexp.MustCompile(`(?i)\b[a-z][a-z0-9+.-]*://[^\s"'<>]+`)
var musicDiagnosticSecret = regexp.MustCompile(`(?i)\b(?:authorization|proxy-authorization|cookie|set-cookie|password|passphrase|secret|(?:api[-_]?|auth[-_]?)?token|api[-_]?key|ticket)\b\s*["']?\s*[:=].*$`)
var musicDiagnosticVideo = regexp.MustCompile(`(\[youtube[^\]]*\]\s+)[A-Za-z0-9_-]{11}:`)

// A queue cap alone does not bound extraction: a playlist can emit thousands
// of full JSON blobs before Enqueue truncates it. Bound both the subprocess's
// requested entries and the bytes copied into memory.
type musicMetadataBuffer struct {
	buf      bytes.Buffer
	overflow bool
}

// musicMetadataStderr retains the usual bounded diagnostic tail while also
// remembering observed errors or hidden-item warnings. That signal is kept
// separately because the relevant line can scroll out of the tail when a
// playlist produces many diagnostics.
type musicMetadataStderr struct {
	tail       *tailBuffer
	linePrefix []byte
	sawError   bool
}

func newMusicMetadataStderr(max int) *musicMetadataStderr {
	return &musicMetadataStderr{tail: newTailBuffer(max)}
}

func (s *musicMetadataStderr) Write(p []byte) (int, error) {
	n, err := s.tail.Write(p)
	for _, b := range p {
		if b == '\n' {
			if musicMetadataPartialDiagnostic(s.linePrefix) {
				s.sawError = true
			}
			s.linePrefix = s.linePrefix[:0]
			continue
		}
		// Bound the prefix while retaining YouTube's hidden-item warnings.
		if len(s.linePrefix) < 512 {
			s.linePrefix = append(s.linePrefix, b)
		}
	}
	return n, err
}

func (s *musicMetadataStderr) String() string { return s.tail.String() }

func (s *musicMetadataStderr) SawError() bool {
	return s.sawError || musicMetadataPartialDiagnostic(s.linePrefix)
}

func musicMetadataPartialDiagnostic(line []byte) bool {
	line = bytes.ToLower(bytes.TrimSpace(line))
	if bytes.HasPrefix(line, []byte("error:")) {
		return true
	}
	// yt-dlp may retry a playlist after YouTube reports hidden unavailable
	// videos; the retry can succeed, so the UI presents this as a possibility.
	// Current yt-dlp's own YoutubeTab tests expect variants such as
	// "Unavailable videos will be hidden", so match case-insensitively.
	return bytes.HasPrefix(line, []byte("warning: [youtube:tab] youtube said:")) &&
		bytes.Contains(line, []byte("unavailable video")) && bytes.Contains(line, []byte("hidden"))
}

type musicMetadataResult struct {
	Tracks          []models.MusicTrack
	SawSkippedEntry bool
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
	if os.Getenv("HICHAT_MUSIC_EXECUTOR_SOCKET") != "" {
		return exec.LookPath("hichat-media-exec")
	}
	return exec.LookPath("yt-dlp")
})

// extractTracks — call yt-dlp to resolve a URL into one or more tracks.
//
// Video URL (including a watch link with radio/playlist parameters) → one
// track. Explicit playlist URL → N tracks (one per video).
// Each track gets the same RequestedBy fields. Metadata fetched here is
// cheap (no audio extraction, no download); the actual stream URL is
// re-extracted at play time via the same binary because YouTube's signed
// CDN links expire within a few hours.
//
// yt-dlp invocation:
//
//	--flat-playlist     emit one entry per video without descending into formats
//	--no-playlist       select the video when a link also includes a playlist;
//	                    explicit playlist URLs still expand normally
//	--print            only the metadata fields needed for each track
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
	result, err := extractTracksDetailed(parent, urlStr, requesterID, requesterName)
	return result.Tracks, err
}

func extractTracksDetailed(parent context.Context, urlStr, requesterID, requesterName string) (musicMetadataResult, error) {
	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
	defer cancel()

	validationStart := time.Now()
	if err := validateMusicURLNetwork(ctx, urlStr); err != nil {
		return musicMetadataResult{}, err
	}
	validationDuration := time.Since(validationStart)

	// `--` terminates yt-dlp's option parsing. Without it, a caller-supplied
	// `url` like `--exec "wget ..."` would be interpreted as a yt-dlp flag
	// (argument injection → RCE under the server process). Handlers also
	// allow-list the URL scheme, but this is the defense-in-depth layer
	// closest to the actual subprocess.
	bin, err := ytDlpPath()
	if err != nil {
		return musicMetadataResult{}, fmt.Errorf("%w: yt-dlp not available: %w", errToolMissing, err)
	}
	cmd := exec.CommandContext(ctx, bin, extractTracksArgs(urlStr)...) // #nosec G204 -- urlStr is user-supplied, but bin is an absolute path resolved once by ytDlpPath, exec.CommandContext never invokes a shell (no metacharacter-injection vector), validateMusicURLNetwork above enforces a host allow-list (SSRF's primary control here — see music_url_guard.go doc comment) plus a post-DNS private/reserved-IP check, and "--" in extractTracksArgs stops urlStr from being parsed as a yt-dlp flag
	stdout := &musicMetadataBuffer{}
	stderr := newMusicMetadataStderr(ytDlpStderrTailBytes)
	cmd.Stdout, cmd.Stderr = stdout, stderr
	cmd.WaitDelay = subprocessWaitDelay
	runDuration, runErr := runMusicMetadataCommand(ctx, cmd, "extraction", validationDuration, stderr)
	// A cancelled request must not enqueue partially extracted tracks after
	// the caller has left. Keep deadlines classifiable as network failures.
	if ctx.Err() != nil {
		return musicMetadataResult{}, musicMetadataInterruptedError("extraction", ctx.Err())
	}
	if stdout.overflow {
		return musicMetadataResult{}, errMusicMetadataTooLarge
	}
	parsed, err := parseMusicMetadataDetailed(bytes.NewReader(stdout.buf.Bytes()), requesterID, requesterName)
	if err != nil {
		return musicMetadataResult{}, err
	}
	out := parsed.Tracks
	// A non-zero exit alongside playable output is also direct evidence of an
	// incomplete extraction even if the provider's ERROR line was truncated or
	// formatted unexpectedly.
	sawSkippedEntry := parsed.SawSkippedEntry || stderr.SawError() || runErr != nil
	// A playlist may contain unavailable entries. Keep valid entries on a
	// partial exit, but preserve classified errors if nothing can play.
	if len(out) == 0 {
		logMusicMetadataFailure("extraction", validationDuration, runDuration, runErr, stderr.String())
	}
	if len(out) == 0 && runErr != nil {
		return musicMetadataResult{}, &trackPlaybackError{
			Reason: classifyPlaybackFailure(runErr, stderr.String()),
			err:    fmt.Errorf("yt-dlp metadata failed: %w", runErr),
		}
	}
	if len(out) == 0 {
		return musicMetadataResult{}, &trackPlaybackError{Reason: reasonUnavailable, err: errors.New("no playable YouTube videos found")}
	}
	return musicMetadataResult{Tracks: out, SawSkippedEntry: sawSkippedEntry}, nil
}

// Metadata deadlines are provider/network failures, not unclassified HTTP
// 500s. Keep cancellation distinct so a caller leaving does not become a
// misleading provider failure, and retain the cause for errors.Is checks.
func musicMetadataInterruptedError(operation string, cause error) error {
	err := fmt.Errorf("music %s interrupted: %w", operation, cause)
	if errors.Is(cause, context.DeadlineExceeded) {
		return &trackPlaybackError{Reason: reasonNetwork, err: err}
	}
	return err
}

func runMusicMetadataCommand(ctx context.Context, cmd *exec.Cmd, operation string, validationDuration time.Duration, stderr interface{ String() string }) (time.Duration, error) {
	started := time.Now()
	err := cmd.Run()
	duration := time.Since(started)
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		logMusicMetadataFailure(operation, validationDuration, duration, ctx.Err(), stderr.String())
	}
	return duration, err
}

// Only provider warnings/errors belong in diagnostics. Never log command
// arguments, request details, environment dumps, or unredacted signed URLs.
func musicMetadataDiagnostic(tail string) string {
	var lines []string
	for _, line := range strings.Split(musicDiagnosticANSI.ReplaceAllString(tail, ""), "\n") {
		line = strings.TrimSpace(strings.Map(func(r rune) rune {
			if unicode.IsControl(r) {
				return -1
			}
			return r
		}, line))
		if !strings.HasPrefix(line, "WARNING:") && !strings.HasPrefix(line, "ERROR:") {
			continue
		}
		line = musicDiagnosticURL.ReplaceAllString(line, "[url]")
		line = musicDiagnosticSecret.ReplaceAllString(line, "[redacted]")
		line = musicDiagnosticVideo.ReplaceAllString(line, "${1}[video]:")
		lines = append(lines, pkg.RedactSecrets(line))
	}
	diagnostic := []rune(strings.Join(lines, " | "))
	if len(diagnostic) > maxMusicMetadataDiagnosticRunes {
		diagnostic = diagnostic[len(diagnostic)-maxMusicMetadataDiagnosticRunes:]
	}
	return string(diagnostic)
}

func logMusicMetadataFailure(operation string, validationDuration, runDuration time.Duration, cause error, stderr string) {
	musicBotLogger.Warn("yt-dlp metadata diagnostic",
		"operation", operation,
		"validation_ms", validationDuration.Milliseconds(),
		"subprocess_ms", runDuration.Milliseconds(),
		"deadline", errors.Is(cause, context.DeadlineExceeded),
		"reason", classifyPlaybackFailure(cause, stderr),
		"stderr_tail", musicMetadataDiagnostic(stderr))
}

func parseMusicMetadata(r io.Reader, requesterID, requesterName string) ([]models.MusicTrack, error) {
	result, err := parseMusicMetadataDetailed(r, requesterID, requesterName)
	return result.Tracks, err
}

func parseMusicMetadataDetailed(r io.Reader, requesterID, requesterName string) (musicMetadataResult, error) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 4096), 256<<10)
	result := musicMetadataResult{Tracks: make([]models.MusicTrack, 0)}
	for scanner.Scan() {
		var raw ytdlpEntry
		if json.Unmarshal(scanner.Bytes(), &raw) != nil {
			result.SawSkippedEntry = true
			continue
		}
		track := raw.toTrack("", requesterID, requesterName)
		if track.VideoID == "" {
			result.SawSkippedEntry = true
			continue
		}
		result.Tracks = append(result.Tracks, track)
		if len(result.Tracks) == maxQueueLen+1 {
			break
		}
	}
	return result, scanner.Err()
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
		// YouTube's Share/current-address links often include list=RD... and
		// start_radio=1. Resolve the requested video, not its generated radio
		// queue, before connecting the bot. yt-dlp still expands /playlist
		// URLs because they do not identify a particular video.
		"--no-playlist",
		"--flat-playlist",
		"--lazy-playlist",
		"--playlist-end", strconv.Itoa(maxQueueLen + 1),
		"--skip-download",
		"--print", "%(.{id,title,uploader,channel,duration,thumbnail})j",
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
	validationStart := time.Now()
	query = strings.TrimSpace(query)
	if query == "" || len([]rune(query)) > 100 || strings.ContainsAny(query, "\x00\r\n") {
		return nil, fmt.Errorf("%w: search query must be 1-100 characters", pkg.ErrBadRequest)
	}
	validationDuration := time.Since(validationStart)
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
	runDuration, runErr := runMusicMetadataCommand(ctx, cmd, "search", validationDuration, stderr)
	if ctx.Err() != nil {
		return nil, musicMetadataInterruptedError("search", ctx.Err())
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
		logMusicMetadataFailure("search", validationDuration, runDuration, runErr, stderr.String())
		return nil, &trackPlaybackError{Reason: classifyPlaybackFailure(runErr, stderr.String()), err: errors.New("no YouTube search results")}
	}
	return tracks, nil
}

func searchMusicArgs(query string) []string {
	return []string{
		"--ignore-config", "--no-plugin-dirs", "--no-remote-components",
		"--flat-playlist", "--playlist-end", "5", "--skip-download",
		"--print", "%(.{id,title,uploader,channel,duration,thumbnail})j",
		"--socket-timeout", "10", "--extractor-retries", "1",
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
