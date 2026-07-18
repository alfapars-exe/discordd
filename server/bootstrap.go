package main

// Boot-time wiring helpers: music-bot dependency logging, embedded frontend FS, CORS, and environment detection.

import (
	"io/fs"
	"log"
	"os"
	"os/exec"
	"strings"

	"github.com/argeinfina/hichat/config"
	"github.com/argeinfina/hichat/static"
	"github.com/rs/cors"
)

// logMusicBotDeps — runs `yt-dlp --version` and `ffmpeg -version` at boot.
// Output goes to the runtime log so a missing/broken install is obvious
// without having to wait for a /play request to fail. Both are best-effort:
// failures log a warning but don't abort startup, since the rest of the
// server still works without the music bot.
func logMusicBotDeps() {
	if out, err := exec.Command("yt-dlp", "--version").Output(); err != nil {
		log.Printf("[main] WARN yt-dlp not available — music bot will fail: %v", err)
	} else {
		log.Printf("[main] yt-dlp version: %s", strings.TrimSpace(string(out)))
	}
	if out, err := exec.Command("ffmpeg", "-version").Output(); err != nil {
		log.Printf("[main] WARN ffmpeg not available — music bot will fail: %v", err)
	} else {
		first := strings.SplitN(string(out), "\n", 2)[0]
		log.Printf("[main] ffmpeg version: %s", strings.TrimSpace(first))
	}
}

// initFrontendFS loads the embedded frontend. Returns false if no frontend is embedded.
func initFrontendFS() (fs.FS, bool) {
	frontendFS, err := fs.Sub(static.FrontendFS, "dist")
	if err != nil {
		log.Fatalf("[main] failed to access embedded frontend: %v", err)
	}

	hasFrontend := false
	if f, checkErr := frontendFS.(fs.ReadFileFS).ReadFile("index.html"); checkErr == nil && len(f) > 0 {
		hasFrontend = true
		log.Println("[main] embedded frontend detected, SPA serving enabled")
	} else {
		log.Println("[main] no embedded frontend, API-only mode (use Vite dev server for frontend)")
	}

	return frontendFS, hasFrontend
}

func initCORS(cfg *config.Config) (*cors.Cors, []string) {
	// Mobile/native shells always need their custom WebView origins, even
	// in production — these can't be replaced via CORS_ORIGINS because the
	// install script doesn't know which mobile clients connect.
	corsOrigins := []string{
		"capacitor://localhost", // iOS Capacitor WKWebView
		"ionic://localhost",     // iOS Capacitor (legacy scheme)
		// Electron desktop shell — the renderer runs under the custom
		// app:// scheme registered in electron/main.ts. Origin is exactly
		// "app://hichat" (host=hichat, no port). Without this entry the
		// desktop app can't register or log in — the CORS preflight is
		// rejected, and the HttpOnly refresh cookie is never received.
		// This is a first-party origin baked into a signed installer; it
		// can't be spoofed by web content and doesn't rely on the
		// CORS_ORIGINS env var (which the ops team may forget to set).
		"app://hichat",
	}

	// Android Capacitor's WebView uses http(s)://localhost as its page origin
	// even in production, so with AllowCredentials=true these must be allowed
	// for the Android shell to reach the API. They widen the credentialed-CORS
	// surface (a process bound to localhost could issue credentialed requests),
	// so web-only deployments that ship no mobile client can drop them by
	// setting HICHAT_MOBILE_ORIGINS=off (F-8, audit 2026-05-29).
	if !strings.EqualFold(os.Getenv("HICHAT_MOBILE_ORIGINS"), "off") {
		corsOrigins = append(corsOrigins,
			"http://localhost",  // Android Capacitor WebView (legacy)
			"https://localhost", // Android Capacitor WebView (Capacitor 6+)
		)
	}

	// Dev-only origins: the Vite proxy and Electron's hot-reload server.
	// Including these in production CORS would let a developer's local
	// box reach a deployed instance with credentials — small risk, but
	// AllowCredentials=true makes it worth avoiding.
	if !isProduction() {
		corsOrigins = append(corsOrigins,
			"http://localhost:3030",
			"http://localhost:1420",
		)
	}

	// Hugging Face Space embed: only when the operator hosts on HF and
	// has opted in. The old default included https://huggingface.co
	// unconditionally, which expanded the credential-bearing CORS surface
	// to anything HF could be tricked into framing.
	if isHFSpace() {
		corsOrigins = append(corsOrigins, "https://huggingface.co")
	}

	if extra := os.Getenv("CORS_ORIGINS"); extra != "" {
		for _, origin := range strings.Split(extra, ",") {
			origin = strings.TrimSpace(origin)
			if origin != "" {
				corsOrigins = append(corsOrigins, origin)
			}
		}
	}
	log.Printf("[cors] allowed origins: %v", corsOrigins)
	return cors.New(cors.Options{
		AllowedOrigins:   corsOrigins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Authorization", "Content-Type"},
		AllowCredentials: true,
	}), corsOrigins
}

// isProduction returns true when the server is running in a deployed
// configuration. Deliberately conservative — defaults to production unless
// the operator explicitly sets HICHAT_ENV=development.
func isProduction() bool {
	env := strings.ToLower(os.Getenv("HICHAT_ENV"))
	return env != "development" && env != "dev"
}

// isHFSpace returns true when the process is running inside a Hugging Face
// Space (the SDK_SPACE env var is set there).
func isHFSpace() bool {
	return os.Getenv("SPACE_ID") != "" || os.Getenv("SDK_SPACE") != ""
}
