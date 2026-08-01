// Package services — music URL guard: SSRF hardening for the yt-dlp
// subprocess path.
//
// Why host allow-list is the primary control (not IP pre-resolution alone):
// link_preview_service.go's SSRF protection works because Go itself opens
// the TCP connection — its custom DialContext runs on every dial and its
// CheckRedirect runs on every 3xx, so a redirect to a private IP is caught
// mid-flight. The music path is different: yt-dlp, a separate OS process,
// does its own DNS resolution and follows its own redirects. Pre-resolving
// the URL's host in Go and finding a public IP proves nothing about where
// yt-dlp will actually end up — a malicious host can resolve clean and then
// 302 yt-dlp to http://169.254.169.254/. The allow-list closes that gap: only
// a fixed set of known-good hosts is accepted, so an attacker-controlled
// domain never reaches the subprocess regardless of what it redirects to.
// The DNS/private-IP check below is defense-in-depth on top of that, not a
// substitute for it.
//
// The host allow-list alone is NOT sufficient, though. A URL like
// https://www.youtube.com/redirect?q=http://169.254.169.254/ passes every
// check above (allow-listed host, no port, no userinfo, public DNS) — its
// only function is to hand yt-dlp off to an arbitrary target. Worse: any
// youtube.com-family path that none of yt-dlp's dedicated YouTube extractors
// claim falls through to yt-dlp's GenericIE, which fetches the page itself
// and follows redirects / <meta refresh> / <iframe src> / og:video / JSON-LD
// embedUrl to whatever host it finds there — an SSRF primitive the host
// allow-list does nothing to stop. Two more controls close this gap:
//   - validateMusicURLPath below allow-lists the URL *path* per host family,
//     deny-by-default, so /redirect and anything else GenericIE could be
//     handed off to is rejected before yt-dlp ever sees the URL.
//   - both yt-dlp invocations (music_bot_metadata.go, music_bot_pipeline.go)
//     pass `--use-extractors "Youtube.*"`, which disables GenericIE outright:
//     a URL none of the YouTube extractors claim fails with "No suitable
//     extractor found" and yt-dlp never makes a network request for it.
package services

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"path"
	"strings"

	"github.com/argeinfina/hichat/pkg"
)

// musicAllowedHosts is an exact-match allow-list — no suffix/prefix/contains
// matching. Suffix matching would accept "youtube.com.evil.example" (host
// ends with an allowed string) and prefix-stripping would accept
// "evil-youtube.com" style lookalikes. Every entry here must be a literal
// hostname yt-dlp is expected to be pointed at directly.
var musicAllowedHosts = map[string]struct{}{
	"youtube.com":              {},
	"www.youtube.com":          {},
	"m.youtube.com":            {},
	"music.youtube.com":        {},
	"youtu.be":                 {},
	"www.youtu.be":             {},
	"youtube-nocookie.com":     {},
	"www.youtube-nocookie.com": {},
}

// musicURLResolver is a seam over net.DefaultResolver so tests can exercise
// the private-IP rejection branch without touching the network.
var musicURLResolver interface {
	LookupIPAddr(ctx context.Context, host string) ([]net.IPAddr, error)
} = net.DefaultResolver

// validateMusicURLSyntax checks scheme, credentials, host allow-list, and
// port — all information available from the string alone, no I/O. This is
// the primary control: an attacker cannot get past it by controlling DNS or
// a redirect target, because it never resolves anything.
func validateMusicURLSyntax(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("%w: invalid URL", pkg.ErrBadRequest)
	}

	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return fmt.Errorf("%w: unsupported URL scheme", pkg.ErrBadRequest)
	}

	if u.User != nil {
		// "https://youtube.com@evil.example/" — the part before '@' looks
		// like the allow-listed host but url.Parse resolves it as userinfo;
		// evil.example is the real host. Reject outright rather than trying
		// to special-case it.
		return fmt.Errorf("%w: URL must not contain credentials", pkg.ErrBadRequest)
	}

	host := strings.ToLower(u.Hostname())
	host = strings.TrimSuffix(host, ".")

	if port := u.Port(); port != "" {
		wantPort := "80"
		if scheme == "https" {
			wantPort = "443"
		}
		if port != wantPort {
			return fmt.Errorf("%w: non-standard port not allowed", pkg.ErrBadRequest)
		}
	}

	if _, ok := musicAllowedHosts[host]; !ok {
		// Deliberately omit the host from the message here — it's the
		// caller's own input, safe to echo, but keeping the message uniform
		// avoids leaking which hosts were tried across error paths.
		return fmt.Errorf("%w: host not allowed", pkg.ErrBadRequest)
	}

	// The path allow-list below matches by prefix, and url.Parse does NOT
	// normalize dot segments — "/watch/../redirect" keeps its ".." in u.Path
	// and would clear a "/watch" prefix check while actually addressing
	// /redirect. Reject anything non-canonical up front rather than trying to
	// out-guess the prefix comparison, the same shape as the upload path
	// guard added for the canonicalization finding (security review
	// 2026-07-31). path.Clean drops a trailing slash, so tolerate that one
	// difference: "/watch/" and "/watch" address the same resource.
	if cleaned := path.Clean(u.Path); cleaned != u.Path && cleaned+"/" != u.Path {
		return fmt.Errorf("%w: non-canonical URL path", pkg.ErrBadRequest)
	}

	if err := validateMusicURLPath(host, u.Path); err != nil {
		return err
	}

	return nil
}

// youtubeDotComPathPrefixes are the URL path prefixes yt-dlp's dedicated
// YouTube extractors handle for the youtube.com/youtube-nocookie.com host
// family. Anything else (e.g. "/redirect", "/results", "/@handle", "/") is
// rejected here rather than being allowed to reach yt-dlp's GenericIE
// fallback — see the package doc comment for why that fallback is an SSRF
// primitive in its own right.
var youtubeDotComPathPrefixes = []string{"/watch", "/playlist", "/shorts/", "/embed/", "/live/", "/v/"}

// validateMusicURLPath allow-lists the URL path for an already
// host-allow-listed URL, deny-by-default. host must already have passed the
// musicAllowedHosts check.
func validateMusicURLPath(host, path string) error {
	switch host {
	case "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
		"youtube-nocookie.com", "www.youtube-nocookie.com":
		for _, prefix := range youtubeDotComPathPrefixes {
			if strings.HasPrefix(path, prefix) {
				return nil
			}
		}
		return fmt.Errorf("%w: path %q is not a supported YouTube URL", pkg.ErrBadRequest, path)
	case "youtu.be", "www.youtu.be":
		// youtu.be short links are exactly one path segment: /<video-id>.
		// Anything with zero or more than one segment (including "/redirect"
		// style abuse, were youtu.be ever to gain one) is rejected.
		trimmed := strings.Trim(path, "/")
		if trimmed == "" || strings.Count(trimmed, "/") > 0 {
			return fmt.Errorf("%w: path %q is not a supported YouTube URL", pkg.ErrBadRequest, path)
		}
		return nil
	default:
		// Unreachable via validateMusicURLSyntax: the musicAllowedHosts check
		// above already restricts host to one of the cases handled here.
		// Handled explicitly rather than assumed, per this file's existing
		// style (see validateMusicURLNetwork's "unreachable in practice" path).
		return fmt.Errorf("%w: host not allowed", pkg.ErrBadRequest)
	}
}

// validateMusicURLNetwork runs validateMusicURLSyntax and then resolves the
// host, rejecting if any returned IP is private/reserved. This is
// defense-in-depth on top of the allow-list above (e.g. an allow-listed
// hostname whose DNS record has been reconfigured to point at an internal
// address) — the allow-list is what actually stops an attacker from
// choosing an arbitrary destination host.
func validateMusicURLNetwork(ctx context.Context, raw string) error {
	if err := validateMusicURLSyntax(raw); err != nil {
		return err
	}

	u, err := url.Parse(raw)
	if err != nil {
		// Unreachable in practice — validateMusicURLSyntax already parsed
		// raw successfully — but handled explicitly rather than assumed.
		return fmt.Errorf("%w: invalid URL", pkg.ErrBadRequest)
	}
	host := strings.ToLower(u.Hostname())
	host = strings.TrimSuffix(host, ".")

	ips, err := musicURLResolver.LookupIPAddr(ctx, host)
	if err != nil {
		// Fail closed: an unresolvable host is rejected rather than passed
		// through to yt-dlp, which would just perform its own (unchecked)
		// resolution.
		return fmt.Errorf("%w: DNS lookup failed", pkg.ErrBadRequest)
	}
	if len(ips) == 0 {
		return fmt.Errorf("%w: DNS lookup returned no addresses", pkg.ErrBadRequest)
	}

	for _, ip := range ips {
		if isPrivateIP(ip.IP) {
			// Do not include the resolved IP in the error text — it reaches
			// the HTTP response body via handlers/music.go's error mapping.
			return fmt.Errorf("%w: host resolves to a disallowed address", pkg.ErrBadRequest)
		}
	}

	return nil
}
