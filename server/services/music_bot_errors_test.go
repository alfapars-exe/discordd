package services

// Classifier tests: one row per reason code, built from real yt-dlp output
// lines, plus the precedence rules (yt-dlp's last ERROR line beats an
// earlier WARNING; age gate is not a bot check) and the stderr tail buffer.
// If a yt-dlp release rewords a message, the matching row here goes red and
// the code falls back to "unknown" in production — nothing breaks, the toast
// just gets less specific.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/pkg"
)

func TestClassifyPlaybackFailure(t *testing.T) {
	// The real pump error when yt-dlp dies before writing a byte.
	oggEOF := errors.New("oggreader init: EOF")

	cases := []struct {
		name string
		err  error
		tail string
		want musicBotErrorReason
	}{
		{
			name: "403 forbidden",
			err:  oggEOF,
			tail: "ERROR: unable to download video data: HTTP Error 403: Forbidden\n",
			want: reasonForbidden,
		},
		{
			// yt-dlp prints a typographic apostrophe.
			name: "bot check, typographic apostrophe",
			err:  oggEOF,
			tail: "ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.\n",
			want: reasonBotCheck,
		},
		{
			name: "bot check, ascii apostrophe in the error text only",
			err:  errors.New("ERROR: [youtube] x: Sign in to confirm you're not a bot"),
			want: reasonBotCheck,
		},
		{
			name: "age gate is not a bot check",
			err:  oggEOF,
			tail: "ERROR: [youtube] x: Sign in to confirm your age. This video may be inappropriate for some users.\n",
			want: reasonAgeRestricted,
		},
		{
			name: "rate limited",
			err:  oggEOF,
			tail: "ERROR: [youtube] x: Unable to download webpage: HTTP Error 429: Too Many Requests\n",
			want: reasonRateLimited,
		},
		{
			name: "private video",
			err:  oggEOF,
			tail: "ERROR: [youtube] x: Private video. Sign in if you've been granted access to this video\n",
			want: reasonUnavailable,
		},
		{
			name: "requested format missing",
			err:  oggEOF,
			tail: "ERROR: [youtube] x: Requested format is not available. Use --list-formats for a list of available formats\n",
			want: reasonUnavailable,
		},
		{
			name: "geo blocked",
			err:  oggEOF,
			tail: "ERROR: [youtube] x: Video unavailable. The uploader has not made this video available in your country\n",
			want: reasonGeoBlocked,
		},
		{
			name: "network timeout",
			err:  oggEOF,
			tail: "ERROR: [youtube] x: Unable to download webpage: The read operation timed out\n",
			want: reasonNetwork,
		},
		{
			name: "stall watchdog",
			err:  &trackPlaybackError{Reason: reasonStalled, err: fmt.Errorf("%w: no audio progress for 45s", errPlaybackStalled)},
			want: reasonStalled,
		},
		{
			name: "yt-dlp binary missing",
			err:  fmt.Errorf("%w: yt-dlp not available: %w", errToolMissing, exec.ErrNotFound),
			want: reasonToolMissing,
		},
		{
			name: "bare exec.ErrNotFound",
			err:  fmt.Errorf("ffmpeg start: %w", exec.ErrNotFound),
			want: reasonToolMissing,
		},
		{
			name: "deadline anywhere in the chain",
			err:  fmt.Errorf("%w: DNS lookup failed (%w)", pkg.ErrBadRequest, context.DeadlineExceeded),
			want: reasonNetwork,
		},
		{
			// Must not hint at the SSRF guard.
			name: "URL guard rejection",
			err:  fmt.Errorf("%w: host resolves to a disallowed address", pkg.ErrBadRequest),
			want: reasonUnknown,
		},
		{
			name: "nothing to go on",
			err:  nil,
			want: reasonUnknown,
		},
		{
			name: "precedence: last ERROR line beats an earlier WARNING",
			err:  oggEOF,
			tail: "WARNING: [youtube] x: HTTP Error 403: Forbidden. Retrying (1/3)...\n" +
				"ERROR: [youtube] x: Private video. Sign in if you've been granted access to this video\n",
			want: reasonUnavailable,
		},
		{
			name: "precedence: whole tail when there is no ERROR line",
			err:  oggEOF,
			tail: "WARNING: [youtube] x: HTTP Error 429: Too Many Requests\n",
			want: reasonRateLimited,
		},
		{
			name: "case-insensitive",
			err:  oggEOF,
			tail: "ERROR: UNABLE TO DOWNLOAD VIDEO DATA: HTTP ERROR 403: FORBIDDEN\n",
			want: reasonForbidden,
		},
	}
	seen := map[musicBotErrorReason]bool{}
	for _, tc := range cases {
		seen[tc.want] = true
		t.Run(tc.name, func(t *testing.T) {
			if got := classifyPlaybackFailure(tc.err, tc.tail); got != tc.want {
				t.Fatalf("classifyPlaybackFailure(%v, %q) = %q, want %q", tc.err, tc.tail, got, tc.want)
			}
		})
	}

	// Every code in the client contract has at least one row above.
	for _, r := range []musicBotErrorReason{
		reasonForbidden, reasonBotCheck, reasonUnavailable, reasonAgeRestricted, reasonGeoBlocked,
		reasonRateLimited, reasonNetwork, reasonStalled, reasonToolMissing, reasonUnknown,
	} {
		if !seen[r] {
			t.Errorf("no classifier row expects %q", r)
		}
	}
}

func TestPlaybackReason_PrefersCarriedReason(t *testing.T) {
	err := fmt.Errorf("wrapped: %w", &trackPlaybackError{Reason: reasonStalled, err: errors.New("HTTP Error 403")})
	if got := playbackReason(err); got != reasonStalled {
		t.Fatalf("playbackReason = %q, want the carried %q", got, reasonStalled)
	}
	if got := playbackReason(errors.New("HTTP Error 403: Forbidden")); got != reasonForbidden {
		t.Fatalf("playbackReason(plain error) = %q, want %q", got, reasonForbidden)
	}
}

func TestTailBuffer_KeepsLastBytes(t *testing.T) {
	tb := newTailBuffer(ytDlpStderrTailBytes)
	var all bytes.Buffer
	// 20 KiB in uneven chunks, so trimming happens across write boundaries.
	for i := 0; all.Len() < 20<<10; i++ {
		chunk := []byte(strings.Repeat(string(rune('a'+i%26)), 1+i%700))
		all.Write(chunk)
		if _, err := tb.Write(chunk); err != nil {
			t.Fatalf("Write: %v", err)
		}
	}
	want := all.Bytes()[all.Len()-ytDlpStderrTailBytes:]
	if got := tb.String(); got != string(want) {
		t.Fatalf("tail = %d bytes (prefix %q), want the last %d bytes exactly", len(got), got[:min(16, len(got))], ytDlpStderrTailBytes)
	}

	// One write larger than the cap keeps only its own tail.
	big := []byte(strings.Repeat("x", ytDlpStderrTailBytes) + "END")
	if n, _ := tb.Write(big); n != len(big) {
		t.Fatalf("Write reported %d bytes, want %d", n, len(big))
	}
	if got := tb.String(); len(got) != ytDlpStderrTailBytes || !strings.HasSuffix(got, "END") {
		t.Fatalf("after oversized write: len %d, suffix %q", len(got), got[len(got)-3:])
	}
}

func TestLastYtDlpErrorLine(t *testing.T) {
	tail := "[youtube] x: Downloading webpage\nERROR: first\nWARNING: w\n  ERROR: second  \n"
	if got := lastYtDlpErrorLine(tail); got != "ERROR: second" {
		t.Fatalf("lastYtDlpErrorLine = %q, want %q", got, "ERROR: second")
	}
	if got := lastYtDlpErrorLine("WARNING: only\n"); got != "" {
		t.Fatalf("lastYtDlpErrorLine = %q, want empty", got)
	}
}
