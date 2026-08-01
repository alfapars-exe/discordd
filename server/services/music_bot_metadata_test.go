package services

import "testing"

// TestExtractTracksArgs_RestrictsToYoutubeExtractors pins the "--use-extractors
// Youtube.*" flag on extractTracks's yt-dlp invocation. Without it, a URL
// that clears the host+path allow-list (music_url_guard.go) but that no
// dedicated YouTube extractor claims falls through to yt-dlp's GenericIE,
// which fetches the page and can be redirected to an attacker-controlled
// host — see music_url_guard.go's package doc comment. There is no unit test
// for "GenericIE actually stays disabled" (that needs a real yt-dlp binary,
// verified empirically against yt-dlp==2024.11.4 — see the security review
// notes, 2026-08-01); this test only pins that the flag is never dropped
// from the argv again.
func TestExtractTracksArgs_RestrictsToYoutubeExtractors(t *testing.T) {
	args := extractTracksArgs("https://www.youtube.com/watch?v=x")
	assertHasAdjacentPair(t, args, "--use-extractors", "Youtube.*")
}

// TestExtractTracksArgs_URLIsLastAndTerminated pins the two other RCE-relevant
// invariants: "--" precedes the URL (so a URL string can never be parsed as a
// yt-dlp flag) and the URL is the final argv element (so nothing can be
// appended after it that would land before "--" is consumed).
func TestExtractTracksArgs_URLIsLastAndTerminated(t *testing.T) {
	args := extractTracksArgs("https://www.youtube.com/watch?v=x")
	if len(args) < 2 {
		t.Fatalf("argv too short: %v", args)
	}
	if got := args[len(args)-1]; got != "https://www.youtube.com/watch?v=x" {
		t.Fatalf("URL is not the last argv element: got %q", got)
	}
	if got := args[len(args)-2]; got != "--" {
		t.Fatalf("argv element before the URL = %q, want \"--\"", got)
	}
}

// assertHasAdjacentPair fails unless args contains want[0] immediately
// followed by want[1] — i.e. a flag and its value, as exec.Cmd expects them
// (never a single "--flag value" string).
func assertHasAdjacentPair(t *testing.T, args []string, flag, value string) {
	t.Helper()
	for i := 0; i+1 < len(args); i++ {
		if args[i] == flag && args[i+1] == value {
			return
		}
	}
	t.Fatalf("argv %v does not contain adjacent pair %q, %q", args, flag, value)
}
