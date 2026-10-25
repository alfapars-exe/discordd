package services

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"slices"
	"strings"
	"testing"
)

func TestMusicMetadataInterruptedError_PreservesCauseAndClassifiesDeadline(t *testing.T) {
	for _, operation := range []string{"extraction", "search"} {
		t.Run(operation, func(t *testing.T) {
			deadline := musicMetadataInterruptedError(operation, context.DeadlineExceeded)
			if !errors.Is(deadline, context.DeadlineExceeded) {
				t.Fatalf("deadline cause was lost: %v", deadline)
			}
			if code := MusicErrorCode(fmt.Errorf("enqueue: %w", deadline)); code != "MUSIC_NETWORK" {
				t.Fatalf("metadata deadline code = %q, want MUSIC_NETWORK", code)
			}
			canceled := musicMetadataInterruptedError(operation, context.Canceled)
			if !errors.Is(canceled, context.Canceled) || MusicErrorCode(canceled) != "" {
				t.Fatalf("caller cancellation was lost or reported as a provider failure: %v", canceled)
			}
		})
	}
}

func TestExtractTracksArgs_BoundsAndIsolatesExtraction(t *testing.T) {
	args := extractTracksArgs("https://www.youtube.com/playlist?list=example")
	for _, flag := range []string{"--ignore-config", "--no-plugin-dirs", "--no-remote-components", "--flat-playlist", "--lazy-playlist", "--skip-download"} {
		if !slices.Contains(args, flag) {
			t.Errorf("missing isolation/bounding flag %s", flag)
		}
	}
	assertHasAdjacentPair(t, args, "--playlist-end", fmt.Sprint(maxQueueLen+1))
	assertHasAdjacentPair(t, args, "--print", "%(.{id,title,uploader,channel,duration,thumbnail})j")
	assertHasAdjacentPair(t, args, "--socket-timeout", "10")
}

func TestExtractTracksArgs_SelectsVideoFromRadioLink(t *testing.T) {
	// A copied video/radio URL must select the requested song. Without this
	// mode yt-dlp traverses the generated Mix before the bot can join, adding
	// unrelated tracks or timing out the entire play request.
	const raw = "https://www.youtube.com/watch?v=0KbRhUtFwkc&list=RD0KbRhUtFwkc&start_radio=1"
	args := extractTracksArgs(raw)
	if !slices.Contains(args, "--no-playlist") || slices.Contains(args, "--yes-playlist") {
		t.Fatalf("video/radio link would expand its Mix: %v", args)
	}
	assertHasAdjacentPair(t, args, "--", raw)
}

func TestYtdlpEntryToTrack_CanonicalVideoOnly(t *testing.T) {
	entry := ytdlpEntry{
		ID: "BaW_jenozKc", Title: " Example ", Uploader: "Artist", Duration: 10.9,
		WebpageURL:  "https://www.youtube.com/watch?v=BaW_jenozKc&list=playlist",
		OriginalURL: "https://evil.example/redirect", URL: "https://cdn.invalid/signed",
		Thumbnail: "http://localhost/private",
	}
	track := entry.toTrack("https://www.youtube.com/playlist?list=playlist", "user", "Name")
	if track.URL != "https://www.youtube.com/watch?v=BaW_jenozKc" || track.VideoID != entry.ID {
		t.Fatalf("queue entry is not a canonical single video: %+v", track)
	}
	if track.Thumbnail != "https://i.ytimg.com/vi/BaW_jenozKc/hqdefault.jpg" || track.Title != "Example" || track.DurationSeconds != 10 {
		t.Fatalf("unexpected normalized metadata: %+v", track)
	}
	if track.RequestedByUserID != "user" || track.RequestedByName != "Name" || track.Artist != "Artist" {
		t.Fatalf("requester/artist metadata lost: %+v", track)
	}
	if err := validateMusicURLSyntax(track.URL); err != nil {
		t.Fatalf("canonical track fails existing allowlist: %v", err)
	}
}

func TestYtdlpEntryToTrack_RejectsNonVideoIDs(t *testing.T) {
	for _, id := range []string{"", "abc", "../redirect", "a?b12345678", "PL1234567890123456789", "BaW_jenozKc/"} {
		if got := (ytdlpEntry{ID: id}).toTrack("https://www.youtube.com/playlist?list=x", "u", "n"); got.VideoID != "" || got.URL != "" {
			t.Errorf("accepted invalid video ID %q: %+v", id, got)
		}
	}
}

func TestYtdlpEntryToTrack_NormalizesOptionalFields(t *testing.T) {
	for _, duration := range []float64{-1, math.NaN(), math.Inf(1), math.Inf(-1), float64(math.MaxInt)} {
		track := (ytdlpEntry{ID: "BaW_jenozKc", Channel: "Channel", Duration: duration}).toTrack("", "u", "n")
		if track.DurationSeconds != 0 || track.Title != track.VideoID || track.Artist != "Channel" {
			t.Fatalf("invalid optional metadata normalization: %+v", track)
		}
	}
	track := (ytdlpEntry{ID: "BaW_jenozKc", Title: strings.Repeat("Ş", 1000), Uploader: strings.Repeat("Ğ", 1000)}).toTrack("", "u", "n")
	if len([]rune(track.Title)) != 300 || len([]rune(track.Artist)) != 200 {
		t.Fatal("metadata display strings are not bounded by runes")
	}
}

func TestParseMusicMetadata_SkipsInvalidEntriesAndBoundsPlaylist(t *testing.T) {
	var input strings.Builder
	input.WriteString("not json\n{\"id\":\"playlist-entry-id\"}\n")
	for i := 0; i < maxQueueLen+20; i++ {
		fmt.Fprintf(&input, "{\"id\":\"%011d\",\"title\":\"Track %d\"}\n", i, i)
	}
	tracks, err := parseMusicMetadata(strings.NewReader(input.String()), "u", "n")
	if err != nil || len(tracks) != maxQueueLen+1 {
		t.Fatalf("got %d tracks, error %v; want bounded queue+1", len(tracks), err)
	}
	if tracks[0].VideoID != "00000000000" || tracks[0].RequestedByUserID != "u" {
		t.Fatalf("unexpected first valid entry: %+v", tracks[0])
	}
}

func TestParseMusicMetadata_RejectsOversizedLine(t *testing.T) {
	_, err := parseMusicMetadata(strings.NewReader(strings.Repeat("x", 256<<10)), "u", "n")
	if err == nil {
		t.Fatal("unbounded metadata line accepted")
	}
}

func TestMusicMetadataBuffer_BoundsExecCopy(t *testing.T) {
	buf := &musicMetadataBuffer{}
	if _, ok := any(buf).(io.ReaderFrom); ok {
		t.Fatal("ReaderFrom would bypass the Write limit in os/exec's io.Copy")
	}
	if _, err := io.Copy(buf, strings.NewReader(strings.Repeat("x", maxMusicMetadataBytes))); err != nil {
		t.Fatal(err)
	}
	if _, err := buf.Write([]byte("x")); !errors.Is(err, errMusicMetadataTooLarge) || !buf.overflow {
		t.Fatalf("overflow not rejected: %v", err)
	}
	if buf.buf.Len() != maxMusicMetadataBytes {
		t.Fatalf("buffer grew beyond bound: %d", buf.buf.Len())
	}
}

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
