package main

// Public static routes (landing assets, /api/version) plus cache and security header policy.

import (
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/argeinfina/hichat/config"
	"github.com/google/uuid"
)

// startupID is regenerated on every server start. The frontend polls
// /api/version and compares; a different value means a new deploy and
// triggers an in-app "update available" banner.
var startupID = uuid.New().String()

// registerStaticAndUploads sets up the public static endpoints (landing,
// health, version). The /api/uploads/ route used to live here as a raw
// public http.FileServer; it now sits in initRoutes behind the auth
// middleware + per-attachment access checks (see handlers/upload_download.go).
func registerStaticAndUploads(mux *http.ServeMux, cfg *config.Config) {
	// Landing page assets (video, screenshots) — public, no auth
	landingDir := cfg.Upload.Dir + "/../landing"
	landingHandler := http.StripPrefix("/static/landing/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/") || strings.Contains(r.URL.Path, "\\") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "public, max-age=86400")
		http.FileServer(http.Dir(landingDir)).ServeHTTP(w, r)
	}))
	mux.Handle("GET /static/landing/", landingHandler)

	// /api/version — used by the frontend to detect new deploys.
	// startupID is generated once per process, so a server restart (which
	// happens on every HF Space rebuild + redeploy) flips the value and the
	// connected clients show an "update available" banner.
	mux.HandleFunc("GET /api/version", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		fmt.Fprintf(w, `{"version":"%s"}`, startupID)
	})
}

// securityHeaders wraps a handler with standard HTTP security headers.
// Applied to all responses (API + static + SPA).
//
// CSP policy notes:
//   - script-src 'self' 'wasm-unsafe-eval' blob:: bundled JS only;
//     wasm-unsafe-eval lets the deepfilter/dtln WASM filters compile; blob:
//     lets the deepfilter AudioWorklet load from its createObjectURL() module
//     (Chromium gates worklet module loads on script-src, not worker-src)
//   - style-src 'self' 'unsafe-inline': React component <style> + tooltip libs
//     inject inline styles. No external stylesheet hosts allowed after the
//     Manrope/Source Code Pro fonts moved to self-hosted /fonts/* (Mayıs 28
//     2026 Lighthouse follow-up).
//   - font-src 'self' data:: self-hosted woff2 only
//   - img-src includes data: + blob: for avatars/attachments/E2EE thumbnails
//   - connect-src keeps wss: + same-origin API access and adds only the
//     exact operator-configured ws:// LiveKit origin when it validates
//   - frame-ancestors 'none' + X-Frame-Options DENY = double clickjacking defense
//   - HSTS forces HTTPS for 2 years (production deployments behind Caddy/Nginx)
func securityHeaders(next http.Handler, trustedLiveKitURL string) http.Handler {
	connectSrc := "connect-src 'self' wss: https:"
	if liveKitWSSource := trustedLiveKitWSSource(trustedLiveKitURL); liveKitWSSource != "" {
		connectSrc += " " + liveKitWSSource
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("Permissions-Policy", "geolocation=()")
		w.Header().Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
		// COOP isolates the top-level window from same-origin pop-ups; required to
		// re-enable certain high-resolution timing APIs (performance.now() precision,
		// SharedArrayBuffer) and addresses the Lighthouse "Ensure proper origin
		// isolation with COOP" finding (high-severity). same-origin is safe here —
		// we deliberately have no cross-origin window.opener relationships.
		w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		w.Header().Set("Content-Security-Policy",
			"default-src 'self'; "+
				"script-src 'self' 'wasm-unsafe-eval' blob:; "+
				"style-src 'self' 'unsafe-inline'; "+
				"img-src 'self' data: blob: https:; "+
				"font-src 'self' data:; "+
				"media-src 'self' blob:; "+
				connectSrc+"; "+
				"worker-src 'self' blob:; "+
				"frame-ancestors 'none'; "+
				"frame-src 'none'; "+
				"object-src 'none'; "+
				"base-uri 'self'; "+
				"form-action 'self'")
		next.ServeHTTP(w, r)
	})
}

// trustedLiveKitWSSource returns a CSP source for the exact origin of the
// operator-configured LiveKit URL. Cleartext WebSockets are allowed only for
// loopback because remote WS exposes the participant token; remote LiveKit
// endpoints must use WSS. User-controlled per-server URLs are excluded.
func trustedLiveKitWSSource(rawURL string) string {
	if rawURL == "" || strings.ContainsAny(rawURL, "\r\n\t \x00") {
		return ""
	}
	u, err := url.Parse(rawURL)
	if err != nil || u.Scheme != "ws" || u.Opaque != "" || u.User != nil || u.Host == "" || u.RawQuery != "" || u.Fragment != "" {
		return ""
	}
	host := u.Hostname()
	if host == "" || !safeCSPHost(host) || !loopbackCSPHost(host) || strings.HasSuffix(u.Host, ":") {
		return ""
	}
	port, validPort := trustedLiveKitPort(u)
	if !validPort {
		return ""
	}
	if net.ParseIP(host) != nil && strings.Contains(host, ":") {
		host = "[" + strings.ToLower(host) + "]"
	} else {
		host = strings.ToLower(host)
	}
	return u.Scheme + "://" + host + ":" + strconv.Itoa(port)
}

func loopbackCSPHost(host string) bool {
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback()
	}
	return strings.EqualFold(host, "localhost")
}

func trustedLiveKitPort(u *url.URL) (int, bool) {
	rawPort := u.Port()
	if rawPort == "" {
		return 80, true
	}
	port, err := strconv.Atoi(rawPort)
	return port, err == nil && port >= 1 && port <= 65535
}

func safeCSPHost(host string) bool {
	if net.ParseIP(host) != nil {
		return true
	}
	if host == "" || len(host) > 253 {
		return false
	}
	for _, label := range strings.Split(host, ".") {
		if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, r := range label {
			switch {
			case r >= 'a' && r <= 'z':
			case r >= 'A' && r <= 'Z':
			case r >= '0' && r <= '9':
			case r == '-':
			default:
				return false
			}
		}
	}
	return true
}

// setStaticCacheHeaders applies cache lifetimes to embedded frontend assets.
//
// Vite emits content-hashed filenames under /assets/* — every rebuild changes
// the hash, so a cached copy can never refer to stale content. That is a hard
// invariant of Vite's build, which is why "immutable" is safe here without a
// rotating query string. One year is the maximum well-respected by browsers
// and CDNs.
//
// Everything outside /assets/ (index.html, hlogo.png, robots.txt, locales/…)
// keeps its filename across deploys. We send no-cache so the client always
// revalidates — index.html in particular MUST be fresh because it carries the
// references to the current hashed asset bundle.
//
// Lighthouse "Use efficient cache lifetimes" was the largest single audit
// finding (~1.5 MiB savings) — the prior `http.FileServer` sent the embed FS
// with no Cache-Control at all, so every visit re-downloaded the bundle.
func setStaticCacheHeaders(w http.ResponseWriter, path string) {
	if strings.HasPrefix(path, "assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
}

// Only client navigation may fall back to HTML. A stale hashed bundle must
// fail as a resource, so normal import-error recovery can fetch the new index.
func serveFrontend(w http.ResponseWriter, r *http.Request, frontendFS fs.FS, indexHTMLWeb []byte) {
	path := strings.TrimPrefix(r.URL.Path, "/")
	if path == "" {
		path = "index.html"
	}
	if f, err := frontendFS.Open(path); err == nil {
		_ = f.Close() // existence probe; FileServer opens the actual response
		setStaticCacheHeaders(w, path)
		http.FileServer(http.FS(frontendFS)).ServeHTTP(w, r)
		return
	}
	if strings.HasPrefix(path, "assets/") {
		w.Header().Set("Cache-Control", "no-store")
		http.NotFound(w, r)
		return
	}
	if len(indexHTMLWeb) == 0 {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(indexHTMLWeb)
}
