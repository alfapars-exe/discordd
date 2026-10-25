package services

// Playback-failure classification for the music bot. Every failed track is
// reported to clients as a music_bot_error event carrying a fixed reason code
// (see models.MusicBotErrorPayload) — never the raw error or the subprocess
// output, which stay in the server log. This file turns "whatever went wrong
// inside playTrack" into one of those codes.

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"sync"

	"github.com/argeinfina/hichat/pkg"
)

// musicBotErrorReason is the wire value of MusicBotErrorPayload.Reason. The
// client maps each code to an i18n string and treats anything it does not
// recognise as "unknown", so adding a code here needs a client change too.
type musicBotErrorReason string

const (
	reasonForbidden     musicBotErrorReason = "forbidden"
	reasonBotCheck      musicBotErrorReason = "bot_check"
	reasonUnavailable   musicBotErrorReason = "unavailable"
	reasonAgeRestricted musicBotErrorReason = "age_restricted"
	reasonGeoBlocked    musicBotErrorReason = "geo_blocked"
	reasonRateLimited   musicBotErrorReason = "rate_limited"
	reasonNetwork       musicBotErrorReason = "network"
	reasonStalled       musicBotErrorReason = "stalled"
	reasonToolMissing   musicBotErrorReason = "tool_missing"
	reasonUnknown       musicBotErrorReason = "unknown"
)

const (
	// ytDlpStderrTailBytes / ffmpegStderrTailBytes bound how much of each
	// subprocess's stderr playTrack keeps. yt-dlp prints its fatal "ERROR:"
	// line last, so the tail is the part that matters for classification.
	ytDlpStderrTailBytes  = 8 << 10
	ffmpegStderrTailBytes = 2 << 10
	// maxPlaybackErrorLineLen truncates the yt-dlp "ERROR:" line that
	// playTrack folds into its returned (server-side only) error text.
	maxPlaybackErrorLineLen = 300
)

var (
	// errPlaybackStalled — the stall watchdog killed the pipeline.
	errPlaybackStalled = errors.New("playback stalled")
	// errToolMissing — yt-dlp or ffmpeg could not be resolved or started.
	errToolMissing = errors.New("audio tool unavailable")
	// errBotNotConnected — playTrack ran on a bot with no LiveKit audio track.
	errBotNotConnected = errors.New("music bot is not connected to LiveKit")
	// errBotStopping — the bot was stopped while it was being connected or
	// used; getOrCreateBot retries once on it.
	errBotStopping = errors.New("music bot is stopping")
	// errBotStoppedExplicitly — a /play whose bot was stopped on purpose
	// (/music/stop, channel emptied) while the request was connecting or
	// queueing. Client-facing 400: the handler echoes ErrBadRequest messages,
	// and this one carries nothing internal.
	errBotStoppedExplicitly = fmt.Errorf("%w: music bot was stopped", pkg.ErrBadRequest)
)

// trackPlaybackError carries a reason that playTrack already knows (stall,
// missing audio track, classified yt-dlp failure) alongside the error chain.
type trackPlaybackError struct {
	Reason musicBotErrorReason
	err    error
}

func (e *trackPlaybackError) Error() string { return e.err.Error() }
func (e *trackPlaybackError) Unwrap() error { return e.err }

// MusicErrorCode exposes only classified media failures, never subprocess
// stderr or arbitrary dependency errors. Shared by HTTP enqueue and WS play.
func MusicErrorCode(err error) string {
	if errors.Is(err, errToolMissing) {
		return "MUSIC_TOOL_MISSING"
	}
	var playback *trackPlaybackError
	if !errors.As(err, &playback) {
		return ""
	}
	return "MUSIC_" + strings.ToUpper(string(playback.Reason))
}

// playbackReason returns the reason code for an error returned by playTrack
// (or by a stubbed playTrackFn): a *trackPlaybackError's own reason, else
// whatever classifyPlaybackFailure makes of the error text alone.
func playbackReason(err error) musicBotErrorReason {
	var tpe *trackPlaybackError
	if errors.As(err, &tpe) {
		return tpe.Reason
	}
	return classifyPlaybackFailure(err, "")
}

// playbackTextRules is checked in order; the first rule with a matching
// substring wins. Patterns are lowercase and matched against lowercased text.
//
// bot_check matches "not a bot" and the "confirm you are"/"confirm you're"
// forms, not a bare "confirm you": that prefix also matches "Sign in to
// confirm your age", which must classify as age_restricted. yt-dlp prints a
// typographic apostrophe ("you’re"), so both apostrophes are listed.
var playbackTextRules = []struct {
	reason   musicBotErrorReason
	patterns []string
}{
	{reasonBotCheck, []string{"not a bot", "confirm you’re", "confirm you're", "confirm you are"}},
	{reasonAgeRestricted, []string{"confirm your age", "age-restricted", "age restricted", "inappropriate for some users"}},
	// "available in your country" rather than "not available in your
	// country": yt-dlp's wording is "The uploader has not made this video
	// available in your country".
	{reasonGeoBlocked, []string{"available in your country", "geo restrict", "geo-restrict", "from your location"}},
	{reasonRateLimited, []string{"http error 429", "too many requests"}},
	{reasonForbidden, []string{"http error 403", "403: forbidden"}},
	{reasonUnavailable, []string{"video unavailable", "private video", "this video has been removed", "requested format is not available"}},
	{reasonNetwork, []string{
		"unable to download webpage", "timed out", "connection reset",
		"temporary failure in name resolution", "name or service not known",
		"network is unreachable", "connection refused",
	}},
}

// classifyPlaybackFailure maps a playback error plus yt-dlp's stderr tail to a
// reason code. Pure and case-insensitive.
//
// Sentinels win first (tool missing, stall). Then the text rules are tried
// against three sources in priority order — the last "ERROR:" line of the
// tail, the whole tail, then the error text — and the first source that
// matches any rule decides, so yt-dlp's fatal line beats an earlier WARNING
// that mentions a different failure. A context deadline anywhere in the chain
// is a network failure. Everything else, including a pkg.ErrBadRequest URL
// guard rejection, is "unknown": the code must never hint at the SSRF guard.
func classifyPlaybackFailure(err error, ytStderrTail string) musicBotErrorReason {
	if errors.Is(err, errToolMissing) || errors.Is(err, exec.ErrNotFound) {
		return reasonToolMissing
	}
	if errors.Is(err, errPlaybackStalled) {
		return reasonStalled
	}

	sources := []string{lastYtDlpErrorLine(ytStderrTail), ytStderrTail, pkg.ErrText(err)}
	for _, src := range sources {
		if src == "" {
			continue
		}
		text := strings.ToLower(src)
		for _, rule := range playbackTextRules {
			for _, p := range rule.patterns {
				if strings.Contains(text, p) {
					return rule.reason
				}
			}
		}
	}

	if errors.Is(err, context.DeadlineExceeded) {
		return reasonNetwork
	}
	return reasonUnknown
}

// lastYtDlpErrorLine returns the last line of tail that starts with
// "ERROR:" (after trimming whitespace), or "" if there is none.
func lastYtDlpErrorLine(tail string) string {
	lines := strings.Split(tail, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if strings.HasPrefix(line, "ERROR:") {
			return line
		}
	}
	return ""
}

// truncateRunes shortens s to at most n runes.
func truncateRunes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// tailBuffer is an io.Writer that keeps only the last max bytes written to
// it. exec.Cmd copies a subprocess's stderr into it from its own goroutine
// while playTrack may read it, so access is mutex-protected.
type tailBuffer struct {
	mu  sync.Mutex
	max int
	buf []byte
}

func newTailBuffer(max int) *tailBuffer {
	return &tailBuffer{max: max}
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	n := len(p)
	if n >= t.max {
		t.buf = append(t.buf[:0], p[n-t.max:]...)
		return n, nil
	}
	t.buf = append(t.buf, p...)
	if over := len(t.buf) - t.max; over > 0 {
		copy(t.buf, t.buf[over:])
		t.buf = t.buf[:t.max]
	}
	return n, nil
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.buf)
}
