package config

import (
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/joho/godotenv"
)

type Config struct {
	Server          ServerConfig
	Database        DatabaseConfig
	JWT             JWTConfig
	LiveKit         LiveKitConfig
	Upload          UploadConfig
	Email           EmailConfig
	DiagSMTP        DiagSMTPConfig
	Klipy           KlipyConfig
	Backup          BackupConfig
	Logging         LoggingConfig
	EncryptionKey   string // AES-256 key (64 hex chars = 32 bytes) for LiveKit credential encryption
	HetznerAPIToken string // Hetzner Cloud API token (read-only) — optional
	// TrustedProxies is the raw CIDR/IP list parsed from the
	// TRUSTED_PROXIES env var. The ratelimit package consumes it via
	// SetTrustedProxies at boot; the IP-extraction logic uses it to
	// decide whether X-Forwarded-For is honoured for the request.
	TrustedProxies []string
}

// EmailConfig — optional. If RESEND_API_KEY is empty, password reset is disabled.
type EmailConfig struct {
	ResendAPIKey string
	FromEmail    string // e.g. noreply@mqvi.app
	AppURL       string // e.g. https://app.mqvi.app — used in reset links
}

// DiagSMTPConfig — Gmail SMTP for emailing diagnostics reports to the admin.
// Optional: if User/Pass are empty, email is skipped (reports still archive via
// the feedback channel). The password MUST come from the environment / a HF
// Space secret — never commit it to source.
type DiagSMTPConfig struct {
	Host string
	Port int
	User string
	Pass string
	From string // display + address; defaults to "kariyerplatformu <User>"
	To   string // admin recipient
}

// KlipyConfig — optional. If KLIPY_API_KEY is empty, GIF search is disabled.
type KlipyConfig struct {
	APIKey string
}

type ServerConfig struct {
	Host string
	Port int
}

type DatabaseConfig struct {
	Path string
}

type JWTConfig struct {
	Secret             string
	AccessTokenExpiry  int // minutes (default: 1440 = 24 hours)
	RefreshTokenExpiry int // days (default: 7)
}

type LiveKitConfig struct {
	URL       string
	APIKey    string
	APISecret string
}

type UploadConfig struct {
	Dir     string
	MaxSize int64 // bytes (default: 25MB)
}

// BackupConfig — disaster-recovery snapshots to a Hugging Face Storage
// Bucket. Disabled when HF_TOKEN is empty so dev / self-host deployments
// without HF credentials boot without errors.
//
// Mirrored content:
//   - SQLite DB via `sqlite3 VACUUM INTO` (consistent snapshot while open)
//   - Upload directory via `hf sync --delete`
//
// The live mirror lives at `hf://buckets/<HFBucket>/latest/{db,uploads}/...`
// and is overwritten in place every cycle. Point-in-time recovery comes from
// a second, dated copy of the DB at `hf://buckets/<HFBucket>/daily/<YYYY-MM-DD>/
// hichat.db` (one per UTC day, pruned to DailyKeep). Uploads are deliberately
// NOT versioned — a dated copy of a multi-GB media tree per day would multiply
// the bucket budget by the retention window.
type BackupConfig struct {
	Enabled   bool          // true when HFToken is set
	HFToken   string        // HF API token with write access to HFBucket
	HFBucket  string        // e.g. "argeinfina/discord"
	Interval  time.Duration // backup frequency (default 24h)
	DBPath    string        // SQLite source file
	UploadDir string        // uploads root mirror target
	WorkDir   string        // local staging area for the DB snapshot
	// DailyKeep is how many dated DB snapshots to retain under `daily/`.
	// Values <= 0 fall back to the 7-day default rather than pruning
	// everything — "keep zero backups" is never the intent behind a
	// missing or malformed env var.
	DailyKeep int
}

// defaultBackupDailyKeep is a week of dated DB snapshots. A week covers the
// realistic detection window for silent corruption (long enough that someone
// notices over a weekend, short enough that the retained copies stay cheap —
// the DB is small and Xet dedups unchanged pages).
const defaultBackupDailyKeep = 7

// LoggingConfig configures structured logging (slog) and optional Sentry
// error tracking. Zero values are safe: an empty SentryDSN disables Sentry
// entirely so local dev and self-host deployments boot without it.
type LoggingConfig struct {
	Level       string // debug | info | warn | error
	Format      string // json | text
	SentryDSN   string // empty disables Sentry
	Environment string // e.g. production, staging, development
	Release     string // version/commit tag attached to Sentry events
}

// defaultLogFormat picks text for human-friendly local development and JSON
// everywhere else so log aggregation gets machine-parseable output by default.
func defaultLogFormat(env string) string {
	if env == "development" || env == "dev" || env == "local" {
		return "text"
	}
	return "json"
}

// Load reads configuration from environment variables.
// Falls back to .env file in development.
func Load() (*Config, error) {
	_ = godotenv.Load()

	port, err := strconv.Atoi(getEnv("SERVER_PORT", "9090"))
	if err != nil {
		return nil, fmt.Errorf("invalid SERVER_PORT: %w", err)
	}

	// Default 1440 = 24 hours. The HTTP client transparently refreshes via the
	// HttpOnly refresh-token cookie on 401, but real users hit the 401 window
	// as "Unauthorized" toast spikes when their tab is idle through the access
	// TTL — surfacing them as broken UI even though the retry succeeds. A 24h
	// access token keeps the refresh path as the rotation mechanism without
	// punishing normal day-long sessions. The localStorage mirror is XSS-
	// exposed for longer (24h vs 15m) but that's a deliberate trade chosen by
	// the operator; tighten via JWT_ACCESS_EXPIRY_MINUTES env if needed.
	accessExpiry, err := strconv.Atoi(getEnv("JWT_ACCESS_EXPIRY_MINUTES", "1440"))
	if err != nil {
		return nil, fmt.Errorf("invalid JWT_ACCESS_EXPIRY_MINUTES: %w", err)
	}

	refreshExpiry, err := strconv.Atoi(getEnv("JWT_REFRESH_EXPIRY_DAYS", "7"))
	if err != nil {
		return nil, fmt.Errorf("invalid JWT_REFRESH_EXPIRY_DAYS: %w", err)
	}

	maxSize, err := strconv.ParseInt(getEnv("UPLOAD_MAX_SIZE", "26214400"), 10, 64) // 25MB
	if err != nil {
		return nil, fmt.Errorf("invalid UPLOAD_MAX_SIZE: %w", err)
	}

	// Diagnostics-report SMTP port (Gmail STARTTLS = 587). A bad value falls
	// back to 587 rather than failing boot, since the email path is optional.
	diagPort, err := strconv.Atoi(getEnv("DIAG_SMTP_PORT", "587"))
	if err != nil {
		diagPort = 587
	}

	// Backup config — disabled when HF_TOKEN is missing.
	//
	// Default lowered from 24h → 1h after the HF Space restart-loses-data
	// incident: /data is ephemeral on Spaces without paid Persistent Storage,
	// so the worst-case "last successful snapshot" window directly maps to
	// user-visible data loss (audit logs, messages, etc.). 1h keeps the loss
	// window small while staying well below HF API throttling — Xet dedup
	// means an unchanged DB uploads near-zero bytes.
	//
	// BACKUP_INTERVAL_MINUTES (optional) is a finer-grain override; when
	// set to a valid integer >= 15 it wins over BACKUP_INTERVAL_HOURS. The
	// 15-minute floor exists because anything tighter starts costing more
	// in HF metadata round-trips than the marginal recovery-point gain.
	backupHours, err := strconv.Atoi(getEnv("BACKUP_INTERVAL_HOURS", "1"))
	if err != nil {
		return nil, fmt.Errorf("invalid BACKUP_INTERVAL_HOURS: %w", err)
	}
	if backupHours < 1 {
		backupHours = 1
	}
	backupInterval := time.Duration(backupHours) * time.Hour
	if mStr := getEnv("BACKUP_INTERVAL_MINUTES", ""); mStr != "" {
		m, mErr := strconv.Atoi(mStr)
		if mErr != nil {
			return nil, fmt.Errorf("invalid BACKUP_INTERVAL_MINUTES: %w", mErr)
		}
		if m >= 15 {
			backupInterval = time.Duration(m) * time.Minute
		}
	}
	// BACKUP_DAILY_KEEP (optional) is the number of dated DB snapshots kept
	// under the bucket's `daily/` prefix. A malformed or non-positive value
	// falls back to the 7-day default instead of erroring the boot: this
	// knob is retention tuning, not a correctness input, and a typo here
	// must never be the reason the process refuses to start (or, worse,
	// the reason history gets pruned to nothing).
	dailyKeep := defaultBackupDailyKeep
	if kStr := getEnv("BACKUP_DAILY_KEEP", ""); kStr != "" {
		if k, kErr := strconv.Atoi(kStr); kErr == nil && k > 0 {
			dailyKeep = k
		} else {
			log.Printf("[config] ignoring invalid BACKUP_DAILY_KEEP=%q, using %d", kStr, dailyKeep)
		}
	}

	hfToken := getEnv("HF_TOKEN", "")

	jwtSecret := getEnv("JWT_SECRET", "")
	if jwtSecret == "" {
		return nil, fmt.Errorf("JWT_SECRET environment variable is required")
	}
	// Reject trivially weak signing keys. A short secret is brute-forceable
	// offline against any captured token, which would let an attacker forge
	// access tokens for any user. 32 chars is the floor for an HS256 key.
	// Generate a strong one with: openssl rand -base64 48
	if len(jwtSecret) < 32 {
		return nil, fmt.Errorf("JWT_SECRET must be at least 32 characters (got %d)", len(jwtSecret))
	}

	encKey := getEnv("ENCRYPTION_KEY", "")
	if encKey == "" {
		return nil, fmt.Errorf("ENCRYPTION_KEY environment variable is required (64 hex chars = 32 byte AES-256 key)")
	}

	// TRUSTED_PROXIES is a comma-separated CIDR/IP list of upstream proxy
	// networks whose X-Forwarded-For headers the rate limiter will honour.
	// Empty → loopback defaults (127.0.0.0/8, ::1/128) — correct for HF
	// Space and most local-dev setups where requests are proxied by an
	// in-host sidecar. Operators behind Cloudflare/Caddy/nginx should set
	// this to the upstream's IP range; anything else lets attackers spoof
	// XFF and bypass per-IP rate limits.
	trustedProxies := splitAndTrim(getEnv("TRUSTED_PROXIES", ""))

	// Logging / observability. Validated here so a typo (e.g. LOG_LEVEL=infos)
	// fails boot loudly instead of silently defaulting to a different verbosity.
	environment := getEnv("ENVIRONMENT", "production")
	logLevel := strings.ToLower(getEnv("LOG_LEVEL", "info"))
	switch logLevel {
	case "debug", "info", "warn", "error":
	default:
		return nil, fmt.Errorf("invalid LOG_LEVEL %q (want one of debug|info|warn|error)", logLevel)
	}
	logFormat := strings.ToLower(getEnv("LOG_FORMAT", defaultLogFormat(environment)))
	switch logFormat {
	case "json", "text":
	default:
		return nil, fmt.Errorf("invalid LOG_FORMAT %q (want one of json|text)", logFormat)
	}

	cfg := &Config{
		Server: ServerConfig{
			Host: getEnv("SERVER_HOST", "0.0.0.0"),
			Port: port,
		},
		Database: DatabaseConfig{
			// DATABASE_URL takes precedence (libsql://... for Turso). Falls back to
			// DATABASE_PATH (local SQLite file) for backward compatibility.
			Path: firstNonEmpty(os.Getenv("DATABASE_URL"), getEnv("DATABASE_PATH", "./data/mqvi.db")),
		},
		JWT: JWTConfig{
			Secret:             jwtSecret,
			AccessTokenExpiry:  accessExpiry,
			RefreshTokenExpiry: refreshExpiry,
		},
		LiveKit: LiveKitConfig{
			URL:       getEnv("LIVEKIT_URL", "ws://localhost:7880"),
			APIKey:    getEnv("LIVEKIT_API_KEY", ""),
			APISecret: getEnv("LIVEKIT_API_SECRET", ""),
		},
		Upload: UploadConfig{
			Dir:     getEnv("UPLOAD_DIR", "./data/uploads"),
			MaxSize: maxSize,
		},
		Email: EmailConfig{
			ResendAPIKey: getEnv("RESEND_API_KEY", ""),
			FromEmail:    getEnv("RESEND_FROM", ""),
			AppURL:       getEnv("APP_URL", ""),
		},
		DiagSMTP: DiagSMTPConfig{
			Host: getEnv("DIAG_SMTP_HOST", "smtp.gmail.com"),
			Port: diagPort,
			User: getEnv("DIAG_SMTP_USER", ""),
			Pass: getEnv("DIAG_SMTP_PASS", ""),
			From: getEnv("DIAG_SMTP_FROM", ""),
			To:   getEnv("DIAG_REPORT_TO", "harun.benli.hb@gmail.com"),
		},
		Klipy: KlipyConfig{
			APIKey: getEnv("KLIPY_API_KEY", ""),
		},
		Backup: BackupConfig{
			Enabled:   hfToken != "",
			HFToken:   hfToken,
			HFBucket:  getEnv("HF_BUCKET", "argeinfina/discord"),
			Interval:  backupInterval,
			DBPath:    firstNonEmpty(os.Getenv("DATABASE_URL"), getEnv("DATABASE_PATH", "./data/mqvi.db")),
			UploadDir: getEnv("UPLOAD_DIR", "./data/uploads"),
			WorkDir:   getEnv("BACKUP_WORKDIR", "/tmp/hichat-backup"),
			DailyKeep: dailyKeep,
		},
		Logging: LoggingConfig{
			Level:       logLevel,
			Format:      logFormat,
			SentryDSN:   getEnv("SENTRY_DSN", ""),
			Environment: environment,
			Release:     getEnv("RELEASE", ""),
		},
		EncryptionKey:   encKey,
		HetznerAPIToken: getEnv("HETZNER_API_TOKEN", ""),
		TrustedProxies:  trustedProxies,
	}

	return cfg, nil
}

// Addr returns the listen address (e.g. "0.0.0.0:8080").
func (c *ServerConfig) Addr() string {
	return fmt.Sprintf("%s:%d", c.Host, c.Port)
}

func getEnv(key, fallback string) string {
	if val, ok := os.LookupEnv(key); ok {
		return val
	}
	return fallback
}

// splitAndTrim parses a comma-separated env var into a non-empty trimmed
// slice. Used for list-style settings like TRUSTED_PROXIES where the
// caller wants to skip blanks rather than treat them as wildcard entries.
func splitAndTrim(raw string) []string {
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// firstNonEmpty returns the first non-empty string from values, or "" if all are empty.
func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
