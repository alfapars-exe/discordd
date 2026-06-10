package main

// Public static routes (landing assets, /api/version) plus cache and security header policy.

import (
	"fmt"
	"net/http"
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
//   - connect-src includes wss: for WebSocket + same-origin for API
//   - frame-ancestors 'none' + X-Frame-Options DENY = double clickjacking defense
//   - HSTS forces HTTPS for 2 years (production deployments behind Caddy/Nginx)
func securityHeaders(next http.Handler) http.Handler {
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
				"connect-src 'self' wss: https:; "+
				"worker-src 'self' blob:; "+
				"frame-ancestors 'none'; "+
				"frame-src 'none'; "+
				"object-src 'none'; "+
				"base-uri 'self'; "+
				"form-action 'self'")
		next.ServeHTTP(w, r)
	})
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
