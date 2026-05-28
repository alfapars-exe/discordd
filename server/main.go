package main

import (
	"context"
	"fmt"
	"html"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/argeinfina/hichat/config"
	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg/crypto"
	"github.com/argeinfina/hichat/pkg/i18n"
	"github.com/argeinfina/hichat/pkg/ratelimit"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/static"
	"github.com/argeinfina/hichat/ws"
	"github.com/google/uuid"
	"github.com/rs/cors"
)

// startupID is regenerated on every server start. The frontend polls
// /api/version and compares; a different value means a new deploy and
// triggers an in-app "update available" banner.
var startupID = uuid.New().String()

func init() {
	// Windows registry can return wrong MIME types for some extensions.
	// Force correct values so http.FileServer serves them properly.
	mime.AddExtensionType(".svg", "image/svg+xml")
	mime.AddExtensionType(".wasm", "application/wasm")
	mime.AddExtensionType(".js", "text/javascript")
	mime.AddExtensionType(".css", "text/css")
}

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

func main() {
	log.SetFlags(log.Ldate | log.Ltime | log.Lshortfile)
	log.Println("[main] HiChat! server starting...")

	// 1. Config
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("[main] failed to load config: %v", err)
	}
	log.Printf("[main] config loaded (port=%d)", cfg.Server.Port)

	// Apply trusted-proxy list to the rate limiter before any request can
	// land. Empty list keeps the safe loopback defaults; an invalid CIDR
	// in TRUSTED_PROXIES is fatal — better to fail boot than silently
	// fall back to "trust no proxy" and break legitimate rate-limit
	// signals from a real upstream.
	if err := ratelimit.SetTrustedProxies(cfg.TrustedProxies); err != nil {
		log.Fatalf("[main] invalid TRUSTED_PROXIES: %v", err)
	}

	// Log music-bot dependency versions so missing binaries are obvious from
	// the boot log instead of buried inside per-track Enqueue failures.
	logMusicBotDeps()

	// 2. Database
	migrationsFS, err := fs.Sub(database.EmbeddedMigrations, "migrations")
	if err != nil {
		log.Fatalf("[main] failed to access embedded migrations: %v", err)
	}

	db, err := database.New(cfg.Database.Path, migrationsFS)
	if err != nil {
		log.Fatalf("[main] failed to initialize database: %v", err)
	}
	defer db.Close()

	// 3. i18n
	localesFS, err := fs.Sub(i18n.EmbeddedLocales, "locales")
	if err != nil {
		log.Fatalf("[main] failed to access embedded locales: %v", err)
	}
	if err := i18n.Load(localesFS); err != nil {
		log.Fatalf("[main] failed to load i18n translations: %v", err)
	}

	// 4. Upload directory. 0750 (not 0755) so only the mqvi service user
	// and group can list/read uploads — uploaded files often include
	// encrypted attachments whose metadata leaking to "other" is undesirable.
	// HTTP responses still serve them publicly via http.FileServer; this
	// only restricts shell access on the host.
	if err := os.MkdirAll(cfg.Upload.Dir, 0o750); err != nil {
		log.Fatalf("[main] failed to create upload directory: %v", err)
	}

	// 5. Repository layer
	repos := initRepositories(db.Conn)

	// 6. Encryption key
	encryptionKey, err := crypto.DeriveKey(cfg.EncryptionKey)
	if err != nil {
		log.Fatalf("[main] invalid ENCRYPTION_KEY: %v", err)
	}

	// 7. Startup hooks — each is independently testable and has a single
	// reason to change. Run order matters: ID repair has to happen before
	// LiveKit seeding so an orphan empty-ID instance isn't seeded over.
	repairCorruptIDs(db)
	resetStalePresence(db)
	seedPlatformLiveKit(db, repos, cfg, encryptionKey)
	// PLATFORM_ADMIN_USERNAME is read from env so the "who's admin?"
	// decision lives in HF Space secrets, not in committed source.
	bootstrapPlatformAdmin(db, os.Getenv("PLATFORM_ADMIN_USERNAME"))

	// 8. WebSocket Hub
	hub := ws.NewHub()

	// 9. Service layer (order matters: channelPerm -> voice -> p2pCall -> rest)
	svcs, limiters, metricsCollector := initServices(db.Conn, repos, hub, cfg, encryptionKey)

	// 9b. Wire structured app logger into Hub and services
	hub.SetAppLogger(svcs.AppLog)
	svcs.Voice.SetAppLogger(svcs.AppLog)
	svcs.P2PCall.SetAppLogger(svcs.AppLog)
	svcs.Auth.SetAppLogger(svcs.AppLog)
	svcs.Backup.SetAppLogger(svcs.AppLog)

	// 9c. Wire audit logger into services that emit moderation events.
	// Each service stores it as a nil-safe optional field; absent wiring
	// the events just don't get recorded (still no functional regression).
	svcs.Voice.SetAuditLogger(svcs.AuditLog)
	svcs.Member.SetAuditLogger(svcs.AuditLog)
	svcs.Role.SetAuditLogger(svcs.AuditLog)
	svcs.Channel.SetAuditLogger(svcs.AuditLog)
	svcs.Server.SetAuditLogger(svcs.AuditLog)
	svcs.Message.SetAuditLogger(svcs.AuditLog)

	// (SetPermInvalidator wiring moved into initServices — single
	// source of truth for service-to-service dependency setup; main.go
	// only owns app-level concerns now.)

	// 9d. Wire the member-timeout checker into voice. messageService
	// gets the timeout repo via its constructor; voiceService uses a
	// setter so existing voice tests don't need to pass the repo to
	// every voice fixture.
	svcs.Voice.SetMemberTimeoutChecker(repos.MemberTimeout)

	// 10. Hub callbacks (must be after services, before hub.Run)
	registerHubCallbacks(hub, repos.User, repos.DM, svcs.Voice, svcs.P2PCall, repos.Channel, repos.Server, svcs.ChannelPermission)

	go hub.Run()

	// Voice orphan cleanup — periodic sweep for stale voice states (30s interval)
	svcs.Voice.StartOrphanCleanup()

	// Voice AFK checker — kicks idle users based on per-server timeout
	svcs.Voice.StartAFKChecker()

	// 10b. Metrics collector — background goroutine polling LiveKit instances
	metricsCollector.Start()

	// 10c. App log service — async writer + auto-purge (30 days)
	svcs.AppLog.Start()

	// 10d. Audit log service — async writer + WS broadcast on moderation events.
	// No auto-purge: audit history is kept indefinitely.
	svcs.AuditLog.Start()

	// 10e. Backup service — periodic snapshot of SQLite + uploads to an HF
	// Storage Bucket. No-op when HF_TOKEN is unset (dev / self-host without
	// HF credentials). See services/backup_service.go for the cycle details.
	svcs.Backup.Start()

	// 11. Handler layer
	h := initHandlers(svcs, repos, limiters, hub, cfg, encryptionKey)

	// 12. HTTP router + routes
	mux := http.NewServeMux()
	initRoutes(mux, h, svcs.Auth, repos.User, repos.Role, repos.Server)

	// 13. Static file serving
	registerStaticAndUploads(mux, cfg)

	// 14. SPA frontend serving
	frontendFS, hasFrontend := initFrontendFS()

	// Rewrite relative paths in index.html for web serving.
	// Vite builds with base "./" for Electron file:// compat, but web needs "/".
	var indexHTMLWeb []byte
	if hasFrontend {
		raw, readErr := fs.ReadFile(frontendFS, "index.html")
		if readErr == nil {
			indexHTMLWeb = []byte(strings.ReplaceAll(string(raw), `"./`, `"/`))
		}
	}

	// 15. CORS (shared origin whitelist for both HTTP CORS and WebSocket upgrade)
	corsHandler, corsOrigins := initCORS(cfg)
	ws.AllowedOrigins = corsOrigins

	// 16. Final handler
	apiHandler := corsHandler.Handler(mux)

	finalHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// WebSocket upgrade bypasses CORS middleware — ws.CheckOrigin handles its own origin validation
		if r.URL.Path == "/ws" {
			mux.ServeHTTP(w, r)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/static/") {
			apiHandler.ServeHTTP(w, r)
			return
		}

		if !hasFrontend {
			apiHandler.ServeHTTP(w, r)
			return
		}

		// OG meta tags for social media crawlers on /invite/{code}
		if isCrawler(r.UserAgent()) {
			if served := serveInviteOG(w, r, svcs.Invite, cfg.Email.AppURL); served {
				return
			}
		}

		// Try static file first
		path := strings.TrimPrefix(r.URL.Path, "/")
		if path == "" {
			path = "index.html"
		}
		if f, openErr := frontendFS.Open(path); openErr == nil {
			f.Close()
			setStaticCacheHeaders(w, path)
			http.FileServer(http.FS(frontendFS)).ServeHTTP(w, r)
			return
		}

		// SPA fallback — index.html must never be cached or users miss new
		// /assets/<hash>.js filenames after a deploy and run a broken half-old build.
		if len(indexHTMLWeb) == 0 {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.Write(indexHTMLWeb)
	})

	// 17. Security headers
	securedHandler := securityHeaders(finalHandler)

	// 18. HTTP Server
	srv := &http.Server{
		Addr:         cfg.Server.Addr(),
		Handler:      securedHandler,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// 19. Graceful shutdown
	done := make(chan os.Signal, 1)
	signal.Notify(done, os.Interrupt, syscall.SIGTERM)

	go func() {
		log.Printf("[main] server listening on %s", cfg.Server.Addr())
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("[main] server error: %v", err)
		}
	}()

	<-done
	log.Println("[main] shutting down...")

	svcs.AppLog.Stop()
	svcs.AuditLog.Stop()
	svcs.Backup.Stop()
	metricsCollector.Stop()
	hub.Shutdown()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		log.Fatalf("[main] forced shutdown: %v", err)
	}

	log.Println("[main] server stopped gracefully")
}

// ─── Startup Helpers ───

// bootstrapPlatformAdmin idempotently grants platform-admin to a known
// username at every server start. Required because the in-app admin endpoint
// (PATCH /api/admin/users/{id}/platform-admin) is auth-gated by the same
// privilege it grants — without a server-side bootstrap there's no way to
// promote the very first admin without manual DB access.
//
// Safe to leave in place: the UPDATE is a no-op once the user is already an
// admin, and ignores users who don't exist yet (e.g. before they register).
func bootstrapPlatformAdmin(db *database.DB, username string) {
	if username == "" {
		return
	}
	res, err := db.Conn.ExecContext(context.Background(),
		`UPDATE users SET is_platform_admin = 1 WHERE username = ? AND is_platform_admin = 0`,
		username,
	)
	if err != nil {
		log.Printf("[main] bootstrap platform admin (%s) failed: %v", username, err)
		return
	}
	if affected, _ := res.RowsAffected(); affected > 0 {
		log.Printf("[main] bootstrapped platform admin: %s", username)
	}
}

// repairCorruptIDs fixes empty-string ID rows left by an old bug. The
// invariant "every row has a non-empty ID" is enforced by the application
// today, but historical rows from earlier code paths may still violate it.
// Best-effort: every step logs and continues on error.
func repairCorruptIDs(db *database.DB) {
	ctx := context.Background()

	// LiveKit instances: rename empty-ID rows to a fresh hex id and rewrite
	// the foreign key on `servers` to match.
	var emptyLK int
	if err := db.Conn.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM livekit_instances WHERE id = ''`).Scan(&emptyLK); err != nil {
		log.Printf("[main] warning: failed to check empty-ID livekit instances: %v", err)
	}
	if emptyLK > 0 {
		var newLKID string
		if err := db.Conn.QueryRowContext(ctx,
			`SELECT lower(hex(randomblob(8)))`).Scan(&newLKID); err != nil {
			log.Printf("[main] warning: failed to generate new livekit ID: %v", err)
		} else {
			if _, err := db.Conn.ExecContext(ctx,
				`UPDATE livekit_instances SET id = ? WHERE id = ''`, newLKID); err != nil {
				log.Printf("[main] warning: failed to update empty-ID livekit instance: %v", err)
			}
			res, fixErr := db.Conn.ExecContext(ctx,
				`UPDATE servers SET livekit_instance_id = ? WHERE livekit_instance_id = ''`, newLKID)
			if fixErr != nil {
				log.Printf("[main] warning: failed to update server livekit refs: %v", fixErr)
			} else if aff, _ := res.RowsAffected(); aff > 0 {
				log.Printf("[main] fixed empty-ID livekit instance → %s (%d server refs updated)", newLKID, aff)
			}
		}
	}

	// Servers with empty IDs are unreachable — drop their cascade rows
	// from related tables, then the server row itself.
	var emptySrv int
	if err := db.Conn.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM servers WHERE id = ''`).Scan(&emptySrv); err != nil {
		log.Printf("[main] warning: failed to check empty-ID servers: %v", err)
	}
	if emptySrv > 0 {
		cleanupTables := []string{"channels", "categories", "roles", "user_roles", "invites", "bans", "server_members"}
		for _, table := range cleanupTables {
			if _, err := db.Conn.ExecContext(ctx,
				fmt.Sprintf(`DELETE FROM %s WHERE server_id = ''`, table)); err != nil {
				log.Printf("[main] warning: failed to clean empty-ID from %s: %v", table, err)
			}
		}
		if _, err := db.Conn.ExecContext(ctx, `DELETE FROM servers WHERE id = ''`); err != nil {
			log.Printf("[main] warning: failed to delete empty-ID servers: %v", err)
		}
		log.Printf("[main] cleaned up %d empty-ID server(s) and related data", emptySrv)
	}
}

// resetStalePresence flips any user marked as online/idle back to offline.
// Required because the WebSocket disconnect handler is the source of truth
// for presence transitions, and it doesn't run if the process was killed.
// Callers' first WS connect after this will set them online again normally.
func resetStalePresence(db *database.DB) {
	result, err := db.Conn.ExecContext(context.Background(),
		`UPDATE users SET status = 'offline' WHERE status IN ('online', 'idle')`)
	if err != nil {
		log.Printf("[main] warning: failed to reset stale presence: %v", err)
		return
	}
	if affected, _ := result.RowsAffected(); affected > 0 {
		log.Printf("[main] reset %d stale user status(es) to offline", affected)
	}
}

// seedPlatformLiveKit ensures a platform-managed LiveKit instance exists in
// the DB whenever the LIVEKIT_URL/KEY/SECRET env triplet is configured. The
// API key and secret are AES-encrypted with the project encryption key
// before insertion. If the instance already exists, we just back-fill any
// servers whose livekit_instance_id is NULL so they pick up the platform
// SFU on next voice connect.
func seedPlatformLiveKit(db *database.DB, repos *Repositories, cfg *config.Config, encryptionKey []byte) {
	if cfg.LiveKit.URL == "" || cfg.LiveKit.APIKey == "" || cfg.LiveKit.APISecret == "" {
		return
	}
	ctx := context.Background()

	platformInstance, seedErr := repos.LiveKit.GetLeastLoadedPlatformInstance(ctx)
	if seedErr != nil {
		encKey, encErr := crypto.Encrypt(cfg.LiveKit.APIKey, encryptionKey)
		if encErr != nil {
			log.Fatalf("[main] failed to encrypt platform livekit key: %v", encErr)
		}
		encSecret, encErr := crypto.Encrypt(cfg.LiveKit.APISecret, encryptionKey)
		if encErr != nil {
			log.Fatalf("[main] failed to encrypt platform livekit secret: %v", encErr)
		}

		platformInstance = &models.LiveKitInstance{
			URL:               cfg.LiveKit.URL,
			APIKey:            encKey,
			APISecret:         encSecret,
			IsPlatformManaged: true,
			ServerCount:       0,
		}
		if createErr := repos.LiveKit.Create(ctx, platformInstance); createErr != nil {
			log.Fatalf("[main] failed to seed platform livekit instance: %v", createErr)
		}
		log.Printf("[main] seeded platform LiveKit instance (url=%s, id=%s)", cfg.LiveKit.URL, platformInstance.ID)
	} else {
		// Instance already exists. Keep its stored (encrypted) credentials in
		// sync with the env triplet so rotating LIVEKIT_URL/KEY/SECRET and
		// restarting actually updates the key the voice-token signer uses.
		// Without this, the DB keeps the original seed credentials forever and
		// an env rotation silently has no effect (the 2026-05-27 voice outage).
		changed := false
		if platformInstance.URL != cfg.LiveKit.URL {
			platformInstance.URL = cfg.LiveKit.URL
			changed = true
		}
		if cur, err := crypto.Decrypt(platformInstance.APIKey, encryptionKey); err != nil || cur != cfg.LiveKit.APIKey {
			if enc, encErr := crypto.Encrypt(cfg.LiveKit.APIKey, encryptionKey); encErr != nil {
				log.Printf("[main] warning: failed to encrypt rotated platform livekit key: %v", encErr)
			} else {
				platformInstance.APIKey = enc
				changed = true
			}
		}
		if cur, err := crypto.Decrypt(platformInstance.APISecret, encryptionKey); err != nil || cur != cfg.LiveKit.APISecret {
			if enc, encErr := crypto.Encrypt(cfg.LiveKit.APISecret, encryptionKey); encErr != nil {
				log.Printf("[main] warning: failed to encrypt rotated platform livekit secret: %v", encErr)
			} else {
				platformInstance.APISecret = enc
				changed = true
			}
		}
		if changed {
			if updErr := repos.LiveKit.Update(ctx, platformInstance); updErr != nil {
				log.Printf("[main] warning: failed to sync platform livekit credentials from env: %v", updErr)
			} else {
				log.Printf("[main] synced platform LiveKit credentials from env (id=%s)", platformInstance.ID)
			}
		}
	}

	result, linkErr := db.Conn.ExecContext(ctx,
		`UPDATE servers SET livekit_instance_id = ? WHERE livekit_instance_id IS NULL`,
		platformInstance.ID,
	)
	if linkErr != nil {
		log.Printf("[main] warning: failed to link orphan servers to platform livekit: %v", linkErr)
	} else if affected, _ := result.RowsAffected(); affected > 0 {
		log.Printf("[main] linked %d orphan server(s) to platform LiveKit instance", affected)
	}
}

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

	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"status":"ok","service":"hichat"}`)
	})

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
		"http://localhost",      // Android Capacitor WebView (legacy)
		"https://localhost",     // Android Capacitor WebView (Capacitor 6+)
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

// securityHeaders wraps a handler with standard HTTP security headers.
// Applied to all responses (API + static + SPA).
//
// CSP policy notes:
//   - script-src 'self': no inline scripts; bundled JS only
//   - style-src 'self' 'unsafe-inline' fonts.googleapis.com: Tailwind/CSS-in-JS
//     injects inline styles; fonts.googleapis.com hosts the Manrope/Source Code Pro
//     stylesheet preloaded from index.html
//   - font-src 'self' data: fonts.gstatic.com: woff2 font files served from gstatic
//   - img-src includes data: + blob: for avatars/attachments/E2EE thumbnails
//   - connect-src includes wss: for WebSocket + same-origin for API
//   - frame-ancestors 'none' + X-Frame-Options DENY = double clickjacking defense
//   - HSTS forces HTTPS for 2 years (production deployments behind Caddy/Nginx)
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
// finding (~1.5 MiB savings) — the prior `http.FileServer` send the embed FS
// with no Cache-Control at all, so every visit re-downloaded the bundle.
func setStaticCacheHeaders(w http.ResponseWriter, path string) {
	if strings.HasPrefix(path, "assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("Permissions-Policy", "geolocation=()")
		w.Header().Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
		w.Header().Set("Content-Security-Policy",
			"default-src 'self'; "+
				"script-src 'self' 'wasm-unsafe-eval'; "+
				"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "+
				"img-src 'self' data: blob: https:; "+
				"font-src 'self' data: https://fonts.gstatic.com; "+
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

// ─── Social Media Crawler OG Meta Tags ───

var invitePathRe = regexp.MustCompile(`^/invite/([a-f0-9]{16})$`)

var crawlerPatterns = []string{
	"whatsapp", "telegrambot", "twitterbot", "facebookexternalhit",
	"facebot", "linkedinbot", "slackbot", "discordbot",
	"googlebot", "bingbot",
}

func isCrawler(ua string) bool {
	lower := strings.ToLower(ua)
	for _, pattern := range crawlerPatterns {
		if strings.Contains(lower, pattern) {
			return true
		}
	}
	return false
}

// serveInviteOG returns OG meta tag HTML for /invite/{code} crawler requests.
// Social media crawlers can't execute JS, so we serve a minimal HTML with meta tags.
// Returns true if the response was written.
func serveInviteOG(w http.ResponseWriter, r *http.Request, inviteSvc services.InviteService, appURL string) bool {
	matches := invitePathRe.FindStringSubmatch(r.URL.Path)
	if matches == nil {
		return false
	}
	code := matches[1]

	preview, err := inviteSvc.GetPreview(r.Context(), code)
	if err != nil {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, `<!DOCTYPE html><html><head>
<meta property="og:title" content="HiChat! — Davet">
<meta property="og:description" content="Bu davet geçersiz veya süresi dolmuş">
<meta property="og:site_name" content="HiChat!">
</head><body></body></html>`)
		return true
	}

	title := html.EscapeString(preview.ServerName)
	description := fmt.Sprintf("%d members", preview.MemberCount)

	var imageURL string
	if preview.ServerIconURL != nil && *preview.ServerIconURL != "" {
		if appURL != "" {
			imageURL = appURL + *preview.ServerIconURL
		} else {
			imageURL = *preview.ServerIconURL
		}
	} else if appURL != "" {
		imageURL = appURL + "/hlogo.png"
	}

	inviteURL := r.URL.Path
	if appURL != "" {
		inviteURL = appURL + r.URL.Path
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta property="og:type" content="website">
<meta property="og:site_name" content="HiChat!">
<meta property="og:title" content="%s">
<meta property="og:description" content="%s">
<meta property="og:url" content="%s">`,
		title, description, html.EscapeString(inviteURL))

	if imageURL != "" {
		fmt.Fprintf(w, `
<meta property="og:image" content="%s">`, html.EscapeString(imageURL))
	}

	fmt.Fprintf(w, `
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="%s">
<meta name="twitter:description" content="%s">`,
		title, description)

	if imageURL != "" {
		fmt.Fprintf(w, `
<meta name="twitter:image" content="%s">`, html.EscapeString(imageURL))
	}

	fmt.Fprint(w, `
</head>
<body></body>
</html>`)

	return true
}
