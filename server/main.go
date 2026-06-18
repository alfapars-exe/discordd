package main

import (
	"context"
	"io/fs"
	"log"
	"log/slog"
	"mime"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/argeinfina/hichat/config"
	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/middleware"
	"github.com/argeinfina/hichat/pkg/crypto"
	"github.com/argeinfina/hichat/pkg/i18n"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/pkg/ratelimit"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
)

func init() {
	// Windows registry can return wrong MIME types for some extensions.
	// Force correct values so http.FileServer serves them properly.
	mime.AddExtensionType(".svg", "image/svg+xml")
	mime.AddExtensionType(".wasm", "application/wasm")
	mime.AddExtensionType(".js", "text/javascript")
	mime.AddExtensionType(".css", "text/css")
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

	// 1b. Structured logging + optional Sentry. Initialised right after config
	// so the chosen level/format and SENTRY_DSN take effect before any other
	// subsystem logs. From here, existing log.Printf calls flow through slog.
	logx.Init(cfg.Logging)
	slog.Info("structured logging initialised", "log_level", cfg.Logging.Level, "log_format", cfg.Logging.Format)

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

	// 2a. Boot-time restore from HF Bucket — runs BEFORE database.New so
	//     migrations land on the recovered state, not a fresh schema.
	//     No-op when (a) HF_TOKEN unset, (b) DSN is remote libSQL/Turso, or
	//     (c) the local DB file already has data. See services/backup_service.go
	//     for the exact predicate. Failure is logged but does not abort boot
	//     — worst case we start with an empty DB and the next periodic
	//     snapshot (10c below) takes over.
	//
	//     A throwaway BackupService instance is used here because
	//     initServices builds the long-lived one a few steps down and
	//     BackupService is stateless. Holding two for ~10 seconds is
	//     cheaper than threading a parameter through initServices.
	{
		boot := services.NewBackupService(cfg.Backup)
		restoreCtx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		if err := boot.Restore(restoreCtx); err != nil {
			log.Printf("[main] backup restore failed (continuing with whatever DB is on disk): %v", err)
		}
		cancel()
	}

	// 2b. Database
	migrationsFS, err := fs.Sub(database.EmbeddedMigrations, "migrations")
	if err != nil {
		log.Fatalf("[main] failed to access embedded migrations: %v", err)
	}

	db, err := database.New(cfg.Database.Path, migrationsFS)
	if err != nil {
		log.Fatalf("[main] failed to initialize database: %v", err)
	}
	// Closed explicitly at the end of the graceful-shutdown sequence — a
	// defer here never ran anyway on the log.Fatalf boot-failure paths
	// (gocritic exitAfterDefer), and on those paths process exit reclaims
	// the handle; SQLite WAL recovers on next boot.

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

	// 10f. Runtime stats logger — periodic process metrics into the structured
	// log stream (no external scraper on a single-instance HF Space).
	stopRuntimeStats := startRuntimeStatsLogger(hub, db, time.Minute)

	// 10g. Maintenance sweeper — hourly purge of expired sessions and stale
	// link-preview cache rows (audit P1-BD-04: DeleteExpired had no caller,
	// so both tables grew without bound).
	stopMaintenance := startMaintenanceSweeper(repos.Session, repos.LinkPreview, time.Hour)

	// Bot service: powers the auth middleware (accept hb_-prefixed bot tokens
	// and resolve them to their bot users row — outbound bot REST calls reuse
	// the existing handlers, which read the caller from UserContextKey), the
	// owner-facing bot management endpoints (create/list/revoke), AND the
	// read-only WS bot gateway (handler.go botValidator). Constructed before
	// the handler layer so the WS handler can validate bot tokens.
	botService := services.NewBotService(repository.NewBotRepository(db.Conn))

	// 11. Handler layer
	h := initHandlers(svcs, repos, limiters, hub, cfg, encryptionKey, botService)

	// 12. HTTP router + routes
	mux := http.NewServeMux()
	authMw := initRoutes(mux, h, svcs.Auth, repos.User, repos.Role, repos.Server, limiters.DeviceEnum, botService)

	// Wire the auth user-cache invalidator into the admin user service so a
	// platform ban / hard-delete / admin-status change drops the cached user
	// row immediately, instead of letting a just-banned account keep making
	// authenticated REST calls until the ~30s cache TTL expires (F-7).
	svcs.AdminUser.SetUserCacheInvalidator(authMw)

	// 13. Static file serving
	registerStaticAndUploads(mux, cfg)

	// 13b. Health & readiness, registered here (not in registerStaticAndUploads)
	// because the readiness probe needs the DB handle. /api/health stays a
	// shallow liveness check (the Docker HEALTHCHECK uses it); /api/ready does
	// the deep DB check and may return 503.
	mux.HandleFunc("GET /api/health", healthHandler())
	mux.HandleFunc("GET /api/ready", readyHandler(db.Conn, cfg))

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
			_ = f.Close() // existence probe only — nothing was read
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

	// 17b. Observability middleware wrapping every route (API, static, SPA).
	// RequestLogger (outermost) assigns a request_id and writes one access-log
	// line per request; Recover catches handler panics, logs them with a stack
	// trace (forwarded to Sentry), and returns 500 instead of dropping the conn.
	rootHandler := middleware.RequestLogger(slog.Default())(
		middleware.Recover(slog.Default())(securedHandler),
	)

	// 18. HTTP Server
	srv := &http.Server{
		Addr:         cfg.Server.Addr(),
		Handler:      rootHandler,
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
	// Final backup BEFORE exit: the AppLog/AuditLog Stop() calls above
	// already drained pending rows into the local DB, so this snapshot
	// captures the latest Denetim/audit events and uploads them to the HF
	// bucket — closing the data-loss window on graceful (SIGTERM) restarts.
	// Bounded by its own timeout, independent of the 5s HTTP-shutdown budget.
	backupShutdownCtx, backupShutdownCancel := context.WithTimeout(context.Background(), 3*time.Minute)
	svcs.Backup.Shutdown(backupShutdownCtx)
	backupShutdownCancel()
	stopRuntimeStats()
	stopMaintenance()
	metricsCollector.Stop()
	hub.Shutdown()

	// Deliver any buffered Sentry events before the process exits.
	logx.Flush(2 * time.Second)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	shutdownErr := srv.Shutdown(ctx)
	cancel() // explicit — a defer would never run past the Fatalf below
	if shutdownErr != nil {
		log.Fatalf("[main] forced shutdown: %v", shutdownErr)
	}

	if err := db.Close(); err != nil {
		log.Printf("[main] db close: %v", err)
	}

	log.Println("[main] server stopped gracefully")
}
