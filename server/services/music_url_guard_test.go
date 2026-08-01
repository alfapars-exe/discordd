package services

import (
	"context"
	"errors"
	"net"
	"testing"

	"github.com/argeinfina/hichat/pkg"
)

// TestValidateMusicURL_AcceptsRealYouTubeURLs is the canary: it must stay
// green across every mutation in this file's test suite except "the host
// allow-list check is disabled entirely" or "the path allow-list is disabled
// entirely" — see the mutation table in the security review notes
// (2026-08-01, SSRF hardening). It covers every path shape the path
// allow-list (validateMusicURLPath) accepts, so a too-narrow allow-list
// breaks this test rather than silently breaking the music feature in prod.
func TestValidateMusicURL_AcceptsRealYouTubeURLs(t *testing.T) {
	cases := []string{
		"https://www.youtube.com/watch?v=x",
		"https://youtu.be/x",
		"https://music.youtube.com/watch?v=x",
		"https://www.youtube.com:443/watch?v=x",
		"https://www.youtube.com/playlist?list=X",
		"https://www.youtube.com/shorts/abc",
		"https://www.youtube.com/embed/abc",
		"https://www.youtube.com/live/abc",
		"https://youtu.be/abc",
	}
	for _, raw := range cases {
		t.Run(raw, func(t *testing.T) {
			if err := validateMusicURLSyntax(raw); err != nil {
				t.Fatalf("expected accept, got error: %v", err)
			}
		})
	}
}

// TestValidateMusicURL_RejectsRedirectPath is the pin for the MEDIUM finding:
// an allow-listed host with an off-path redirector is a full SSRF primitive
// even though it clears every host/port/userinfo/DNS check. See the package
// doc comment for the full GenericIE fallback chain this closes.
func TestValidateMusicURL_RejectsRedirectPath(t *testing.T) {
	raw := "https://www.youtube.com/redirect?q=http://169.254.169.254/"
	err := validateMusicURLSyntax(raw)
	if err == nil {
		t.Fatal("expected rejection, got nil error")
	}
	if !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("expected pkg.ErrBadRequest, got: %v", err)
	}
}

// TestValidateMusicURL_RejectsUnknownPath covers path shapes on an
// allow-listed host that aren't /redirect but still aren't handled by any of
// yt-dlp's dedicated YouTube extractors, so must not be forwarded either.
func TestValidateMusicURL_RejectsUnknownPath(t *testing.T) {
	cases := []string{
		"https://www.youtube.com/",
		"https://www.youtube.com/results?search_query=x",
		"https://www.youtube.com/@someone",
	}
	for _, raw := range cases {
		t.Run(raw, func(t *testing.T) {
			err := validateMusicURLSyntax(raw)
			if err == nil {
				t.Fatal("expected rejection, got nil error")
			}
			if !errors.Is(err, pkg.ErrBadRequest) {
				t.Fatalf("expected pkg.ErrBadRequest, got: %v", err)
			}
		})
	}
}

// TestValidateMusicURL_RejectsNonCanonicalPath covers the gap the prefix
// match leaves open on its own: url.Parse keeps dot segments verbatim, so
// "/watch/../redirect" clears a "/watch" prefix check while addressing
// /redirect. Only the canonicality check stops these — the path allow-list
// alone accepts every one of them.
func TestValidateMusicURL_RejectsNonCanonicalPath(t *testing.T) {
	cases := []string{
		"https://www.youtube.com/watch/../redirect?q=http://169.254.169.254/",
		"https://www.youtube.com/watch/./../results",
		"https://www.youtube.com/embed/../redirect",
	}
	for _, raw := range cases {
		t.Run(raw, func(t *testing.T) {
			err := validateMusicURLSyntax(raw)
			if err == nil {
				t.Fatalf("validateMusicURLSyntax(%q) accepted a non-canonical path", raw)
			}
			if !errors.Is(err, pkg.ErrBadRequest) {
				t.Fatalf("expected pkg.ErrBadRequest, got: %v", err)
			}
		})
	}
}

// A trailing slash is canonical enough — path.Clean strips it, but "/watch/"
// and "/watch" address the same resource, so rejecting it would be a
// gratuitous break of a URL shape users paste routinely.
func TestValidateMusicURL_AcceptsTrailingSlash(t *testing.T) {
	if err := validateMusicURLSyntax("https://www.youtube.com/playlist/?list=X"); err != nil {
		t.Fatalf("expected accept for a trailing-slash path, got: %v", err)
	}
}

func TestValidateMusicURL_RejectsNonAllowlistedHost(t *testing.T) {
	cases := []string{
		"http://169.254.169.254/latest/meta-data/",
		"http://127.0.0.1:8080/",
		"https://evil.example/x",
	}
	for _, raw := range cases {
		t.Run(raw, func(t *testing.T) {
			err := validateMusicURLSyntax(raw)
			if err == nil {
				t.Fatal("expected rejection, got nil error")
			}
			if !errors.Is(err, pkg.ErrBadRequest) {
				t.Fatalf("expected pkg.ErrBadRequest, got: %v", err)
			}
		})
	}
}

func TestValidateMusicURL_RejectsSuffixLookalikeHost(t *testing.T) {
	cases := []string{
		"https://youtube.com.evil.example/x",
		"https://evil-youtube.com/x",
		"https://notyoutu.be/x",
	}
	for _, raw := range cases {
		t.Run(raw, func(t *testing.T) {
			if err := validateMusicURLSyntax(raw); err == nil {
				t.Fatal("expected rejection, got nil error")
			}
		})
	}
}

func TestValidateMusicURL_RejectsUserinfo(t *testing.T) {
	// The allowlisted host must sit in the AUTHORITY position, not the
	// userinfo position. "https://www.youtube.com@evil.example/x" parses with
	// Hostname()=="evil.example", so the allowlist already rejects it and the
	// userinfo branch is never reached — a test written that way passes even
	// with the userinfo check deleted (confirmed by mutation). Here
	// Hostname()=="www.youtube.com" clears the allowlist, so only the userinfo
	// rejection can stop it.
	cases := []string{
		"https://evil.example@www.youtube.com/x",
		"https://user:pass@www.youtube.com/x",
	}
	for _, raw := range cases {
		t.Run(raw, func(t *testing.T) {
			if err := validateMusicURLSyntax(raw); err == nil {
				t.Fatalf("validateMusicURLSyntax(%q) accepted a URL carrying userinfo", raw)
			}
		})
	}
}

func TestValidateMusicURL_RejectsNonWebPort(t *testing.T) {
	cases := []string{
		"https://www.youtube.com:8080/x",
		"http://www.youtube.com:22/x",
	}
	for _, raw := range cases {
		t.Run(raw, func(t *testing.T) {
			if err := validateMusicURLSyntax(raw); err == nil {
				t.Fatal("expected rejection, got nil error")
			}
		})
	}
}

func TestValidateMusicURL_RejectsNonHTTPScheme(t *testing.T) {
	cases := []string{
		"file:///etc/passwd",
		"ftp://www.youtube.com/x",
		"--exec whatever",
	}
	for _, raw := range cases {
		t.Run(raw, func(t *testing.T) {
			if err := validateMusicURLSyntax(raw); err == nil {
				t.Fatal("expected rejection, got nil error")
			}
		})
	}
}

// stubIPResolver is a test double for musicURLResolver — returns a fixed IP
// set for any host so the network-check tests never touch real DNS.
type stubIPResolver struct {
	ips []net.IPAddr
	err error
}

func (s stubIPResolver) LookupIPAddr(_ context.Context, _ string) ([]net.IPAddr, error) {
	return s.ips, s.err
}

// TestValidateMusicURLNetwork_RejectsPrivateIP swaps musicURLResolver for a
// stub so it can drive validateMusicURLNetwork's DNS-result branch without a
// real lookup. It uses a real allow-listed host + a path that clears the
// path allow-list (validateMusicURLPath), so the syntax check passes and the
// network check actually runs — the stub resolver means no real DNS lookup
// happens regardless of which host string is used.
func TestValidateMusicURLNetwork_RejectsPrivateIP(t *testing.T) {
	origResolver := musicURLResolver
	t.Cleanup(func() { musicURLResolver = origResolver })

	rawURL := "https://www.youtube.com/watch?v=x"

	privateCases := []string{
		"127.0.0.1",
		"169.254.169.254",
		"10.0.0.1",
		"::ffff:169.254.169.254",
	}
	for _, ipStr := range privateCases {
		t.Run(ipStr, func(t *testing.T) {
			musicURLResolver = stubIPResolver{ips: []net.IPAddr{{IP: net.ParseIP(ipStr)}}}
			err := validateMusicURLNetwork(context.Background(), rawURL)
			if err == nil {
				t.Fatal("expected rejection, got nil error")
			}
			if !errors.Is(err, pkg.ErrBadRequest) {
				t.Fatalf("expected pkg.ErrBadRequest, got: %v", err)
			}
		})
	}

	t.Run("public IP accepted", func(t *testing.T) {
		musicURLResolver = stubIPResolver{ips: []net.IPAddr{{IP: net.ParseIP("93.184.216.34")}}}
		if err := validateMusicURLNetwork(context.Background(), rawURL); err != nil {
			t.Fatalf("expected accept, got error: %v", err)
		}
	})
}

// TestFlatPlaylistEntryURLStaysAllowlisted is a contract lock: toTrack's
// fallback chain must keep landing on a URL that passes the guard, so a
// change to that chain doesn't silently make playTrack's guard call reject
// every track resolved from a playlist. The explicit track.URL == entry.URL
// check pins the fallback *order*: entry.WebpageURL and entry.OriginalURL
// are both empty here, so entry.URL (the "url" JSON field, i.e. flat-playlist
// entries) must win over falling back to originalUserURL. Without this
// check, deleting the entry.URL fallback branch entirely would still leave
// this test green — resolvedURL would drop straight to originalUserURL,
// which also happens to pass the guard (vacuous pass, confirmed by mutation).
func TestFlatPlaylistEntryURLStaysAllowlisted(t *testing.T) {
	entry := ytdlpEntry{ID: "abc", URL: "https://www.youtube.com/watch?v=abc"}
	track := entry.toTrack("https://www.youtube.com/playlist?list=X", "u", "n")

	if track.URL != entry.URL {
		t.Fatalf("track.URL = %q, want entry.URL = %q — toTrack's fallback chain no longer prefers the per-entry URL", track.URL, entry.URL)
	}
	if err := validateMusicURLSyntax(track.URL); err != nil {
		t.Fatalf("resolved track URL %q failed the guard: %v", track.URL, err)
	}
}
