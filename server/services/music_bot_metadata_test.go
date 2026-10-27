package services

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"os"
	"os/exec"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestMusicMetadataDiagnostic_RedactsSensitiveDetails(t *testing.T) {
	tail := "[debug] Proxy map: password=debug-secret\n" +
		"partial token=partial-secret\n" +
		"\x1b[33mWARNING:\x1b[0m [youtube] 0KbRhUtFwkc: timed out fetching https://www.youtube.com/watch?v=0KbRhUtFwkc&token=url-secret\n" +
		"ERROR: proxy socks5://user:proxy-secret@proxy.example:1080 failed\n" +
		"WARNING: Authorization: Bearer bearer-secret\n" +
		"ERROR: Cookie: session=cookie-secret\n" +
		"WARNING: api_key=key-secret\n" +
		"ERROR: {\"token\":\"json-secret\"}\n" +
		"WARNING: password=two word secret\n" +
		"WARNING: read timed out (retrying 1/1)"
	got := musicMetadataDiagnostic(tail)
	for _, sensitive := range []string{"debug-secret", "partial-secret", "0KbRhUtFwkc", "youtube.com", "url-secret", "proxy-secret", "proxy.example", "bearer-secret", "cookie-secret", "key-secret", "json-secret", "two word secret", "\x1b", "\n"} {
		if strings.Contains(got, sensitive) {
			t.Errorf("diagnostic leaked %q: %q", sensitive, got)
		}
	}
	for _, diagnostic := range []string{"timed out fetching [url]", "proxy [url] failed", "read timed out (retrying 1/1)"} {
		if !strings.Contains(got, diagnostic) {
			t.Errorf("lost useful provider warning %q: %q", diagnostic, got)
		}
	}
}

func TestMusicMetadataDiagnostic_BoundedAndKeepsLastWarning(t *testing.T) {
	got := musicMetadataDiagnostic("WARNING: " + strings.Repeat("Ğ", 3000) + "\nERROR: final provider failure")
	if !utf8.ValidString(got) || utf8.RuneCountInString(got) != maxMusicMetadataDiagnosticRunes {
		t.Fatalf("diagnostic is not valid bounded text: %d bytes, %d runes", len(got), utf8.RuneCountInString(got))
	}
	if !strings.HasSuffix(got, "ERROR: final provider failure") {
		t.Fatalf("latest provider error was lost: %q", got)
	}
	if got := musicMetadataDiagnostic("[debug] token=hidden\ntruncated warning continuation"); got != "" {
		t.Fatalf("non-warning output was logged: %q", got)
	}
}

func TestLogMusicMetadataFailure_EmitsSafeTimingsWithoutChangingError(t *testing.T) {
	// The logger is process-wide. Other service fixtures can still be draining
	// asynchronous callbacks; capture logs in a dedicated process, never by
	// mutating their logger in the parent test process.
	const isolated = "HICHAT_METADATA_LOG_TEST_PROCESS"
	if os.Getenv(isolated) != "1" {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestLogMusicMetadataFailure_EmitsSafeTimingsWithoutChangingError$", "-test.count=1")
		cmd.Env = append(os.Environ(), isolated+"=1")
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("isolated logging assertion failed: %v\n%s", err, output)
		}
		return
	}
	var output bytes.Buffer
	musicBotLogger = slog.New(slog.NewJSONHandler(&output, nil))
	err := musicMetadataInterruptedError("extraction", context.DeadlineExceeded)
	logMusicMetadataFailure("extraction", 7*time.Millisecond, 30000*time.Millisecond, err,
		"WARNING: read timed out fetching https://example.com/?token=secret")
	var record map[string]any
	if decodeErr := json.Unmarshal(output.Bytes(), &record); decodeErr != nil {
		t.Fatal(decodeErr)
	}
	if record["validation_ms"] != float64(7) || record["subprocess_ms"] != float64(30000) || record["deadline"] != true || record["reason"] != "network" {
		t.Fatalf("missing phase/failure evidence: %v", record)
	}
	if record["stderr_tail"] != "WARNING: read timed out fetching [url]" || strings.Contains(output.String(), "secret") {
		t.Fatalf("log output was not sanitized: %s", output.String())
	}
	if !errors.Is(err, context.DeadlineExceeded) || MusicErrorCode(err) != "MUSIC_NETWORK" {
		t.Fatalf("logging changed outward error semantics: %v", err)
	}
}

func TestMusicMetadataArgs_RetainWarningsWithoutVerboseOutput(t *testing.T) {
	for _, args := range [][]string{extractTracksArgs("https://www.youtube.com/watch?v=0KbRhUtFwkc"), searchMusicArgs("song")} {
		for _, forbidden := range []string{"--no-warnings", "--verbose", "--print-traffic", "--dump-pages"} {
			if slices.Contains(args, forbidden) {
				t.Errorf("metadata diagnostics use forbidden flag %q", forbidden)
			}
		}
		assertHasAdjacentPair(t, args, "--socket-timeout", "10")
		assertHasAdjacentPair(t, args, "--extractor-retries", "1")
	}
}

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

func TestParseMusicMetadataDetailed_ReportsObservedInvalidEntry(t *testing.T) {
	input := "{\"id\":\"BaW_jenozKc\",\"title\":\"ok\"}\n{\"id\":\"not-a-video-id\"}\n"
	result, err := parseMusicMetadataDetailed(strings.NewReader(input), "u", "n")
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Tracks) != 1 || !result.SawSkippedEntry {
		t.Fatalf("result=%+v, want one track and observed skipped entry", result)
	}
	clean, err := parseMusicMetadataDetailed(strings.NewReader("{\"id\":\"BaW_jenozKc\"}\n"), "u", "n")
	if err != nil || clean.SawSkippedEntry {
		t.Fatalf("valid metadata marked partial: result=%+v err=%v", clean, err)
	}
}

func TestMusicMetadataStderr_RemembersErrorOutsideTail(t *testing.T) {
	stderr := newMusicMetadataStderr(32)
	// Split the marker across writes and then scroll it outside the bounded
	// diagnostic tail. The user-facing advisory must not depend on tail size.
	_, _ = stderr.Write([]byte("ERR"))
	_, _ = stderr.Write([]byte("OR: unavailable item\n"))
	_, _ = stderr.Write([]byte(strings.Repeat("WARNING: benign\n", 20)))
	if !stderr.SawError() {
		t.Fatal("lost observed ERROR line after stderr tail overflow")
	}
}

func TestMusicMetadataStderr_ReportsHiddenPlaylistItems(t *testing.T) {
	stderr := newMusicMetadataStderr(32)
	_, _ = stderr.Write([]byte("WARNING: [youtube:tab] YouTube said: INFO - 1 unavailable video is hidden\n"))
	_, _ = stderr.Write([]byte(strings.Repeat("WARNING: benign\n", 20)))
	if !stderr.SawError() {
		t.Fatal("lost observed hidden-item warning after stderr tail overflow")
	}
	clean := newMusicMetadataStderr(32)
	_, _ = clean.Write([]byte("WARNING: [youtube:tab] transient network retry\n"))
	if clean.SawError() {
		t.Fatal("unrelated warning marked as partial playlist")
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
