package database

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

// OpenPostgres opens the PostgreSQL application/migration pool with verified
// server TLS, a client certificate, and no plaintext fallback.
func OpenPostgres(ctx context.Context, dsn string) (*sql.DB, error) {
	u, err := url.Parse(dsn)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") {
		return nil, errors.New("PostgreSQL connection must be a postgres URL")
	}
	q := u.Query()
	// HF Space secrets can provide PEMs directly. pgx loads them into its TLS
	// configuration before these private temporary files are removed.
	ca, cert, key := os.Getenv("HICHAT_PG_CA_PEM"), os.Getenv("HICHAT_PG_CERT_PEM"), os.Getenv("HICHAT_PG_KEY_PEM")
	if ca != "" || cert != "" || key != "" {
		if ca == "" || cert == "" || key == "" {
			return nil, errors.New("all three PostgreSQL TLS PEM secrets are required")
		}
		dir, err := os.MkdirTemp("", "hichat-pg-tls-")
		if err != nil {
			return nil, errors.New("cannot prepare PostgreSQL TLS files")
		}
		defer func() {
			if cleanupErr := os.RemoveAll(dir); cleanupErr != nil {
				fmt.Fprintf(os.Stderr, "warning: could not remove temporary PostgreSQL TLS files: %v\n", cleanupErr)
			}
		}()
		for name, value := range map[string]string{"sslrootcert": ca, "sslcert": cert, "sslkey": key} {
			path := filepath.Join(dir, name+".pem")
			if err := os.WriteFile(path, []byte(value), 0600); err != nil {
				return nil, errors.New("cannot prepare PostgreSQL TLS file")
			}
			q.Set(name, path)
		}
		u.RawQuery = q.Encode()
		dsn = u.String()
	}
	if q.Get("sslmode") != "verify-full" || q.Get("sslrootcert") == "" || q.Get("sslcert") == "" || q.Get("sslkey") == "" {
		return nil, errors.New("PostgreSQL requires sslmode=verify-full, sslrootcert, sslcert and sslkey")
	}
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		// Driver parse errors can contain the full DSN, including credentials.
		return nil, errors.New("invalid PostgreSQL connection configuration")
	}
	if cfg.TLSConfig == nil || cfg.TLSConfig.InsecureSkipVerify || len(cfg.Fallbacks) != 0 {
		return nil, errors.New("PostgreSQL TLS verification and no fallback are required")
	}
	cfg.ConnectTimeout = 10 * time.Second
	cfg.RuntimeParams["application_name"] = "hichat"
	cfg.RuntimeParams["timezone"] = "UTC"
	conn := PostgreSQLPool(cfg)
	maxOpen, maxIdle, limitsErr := postgresPoolLimits()
	if limitsErr != nil {
		_ = conn.Close()
		return nil, limitsErr
	}
	conn.SetMaxOpenConns(maxOpen)
	conn.SetMaxIdleConns(maxIdle)
	conn.SetConnMaxLifetime(30 * time.Minute)
	conn.SetConnMaxIdleTime(5 * time.Minute)
	if err := pingPostgresWithRetry(ctx, conn, waitPostgresRetry); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("PostgreSQL connection failed (%s); check TLS, credentials and reachability", postgresConnectFailureCode(err))
	}
	var version int
	if err := conn.QueryRowContext(ctx, "SHOW server_version_num").Scan(&version); err != nil || version < 180000 || version >= 190000 {
		_ = conn.Close()
		return nil, fmt.Errorf("expected PostgreSQL 18, got server_version_num %d", version)
	}
	return conn, nil
}

// Defaults retain the measured production baseline; deployments can tune after
// comparing pool wait duration and HTTP latency at a known DB capacity.
func postgresPoolLimits() (int, int, error) {
	open, idle := 4, 2
	for _, entry := range []struct {
		name string
		dest *int
	}{{"POSTGRES_MAX_OPEN_CONNS", &open}, {"POSTGRES_MAX_IDLE_CONNS", &idle}} {
		if raw := os.Getenv(entry.name); raw != "" {
			n, err := strconv.Atoi(raw)
			if err != nil || n < 0 || n > 256 {
				return 0, 0, fmt.Errorf("invalid %s; expected integer 0..256", entry.name)
			}
			*entry.dest = n
		}
	}
	if open < 2 || idle > open {
		return 0, 0, errors.New("PostgreSQL pool requires max-open >= 2 (one dedicated backend owner) and max-idle <= max-open")
	}
	return open, idle, nil
}
