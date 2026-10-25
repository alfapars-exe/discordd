package database

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
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
	conn.SetMaxOpenConns(4)
	conn.SetMaxIdleConns(2)
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
