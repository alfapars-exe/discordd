package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/joho/godotenv"
)

type Config struct {
	Server          ServerConfig
	Database        DatabaseConfig
	JWT             JWTConfig
	LiveKit         LiveKitConfig
	Upload          UploadConfig
	Email           EmailConfig
	Klipy           KlipyConfig
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

	jwtSecret := getEnv("JWT_SECRET", "")
	if jwtSecret == "" {
		return nil, fmt.Errorf("JWT_SECRET environment variable is required")
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
		Klipy: KlipyConfig{
			APIKey: getEnv("KLIPY_API_KEY", ""),
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
