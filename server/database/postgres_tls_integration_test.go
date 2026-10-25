package database

import (
	"context"
	"database/sql"
	"os"
	"strings"
	"testing"
	"time"
)

// TestOpenPostgresInlinePEMReconnect is an opt-in integration test for the
// production inline-PEM configuration path. It requires a PostgreSQL 18
// endpoint configured for client-certificate authentication. The test-only
// runner in this directory provisions an isolated instance and certificates.
func TestOpenPostgresInlinePEMReconnect(t *testing.T) {
	dsn := os.Getenv("HICHAT_TEST_POSTGRES_TLS_DSN")
	if dsn == "" {
		t.Skip("set HICHAT_TEST_POSTGRES_TLS_DSN to run the PostgreSQL TLS integration test")
	}
	for _, name := range []string{"HICHAT_PG_CA_PEM", "HICHAT_PG_CERT_PEM", "HICHAT_PG_KEY_PEM"} {
		if os.Getenv(name) == "" {
			t.Fatalf("%s is required when HICHAT_TEST_POSTGRES_TLS_DSN is set", name)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := OpenPostgres(ctx, dsn)
	if err != nil {
		t.Fatalf("OpenPostgres with inline PEM failed: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	// OpenPostgres removes its temporary PEM files before returning. Hold the
	// initial pool connection while acquiring another one to force a fresh TLS
	// handshake after that cleanup, then verify both sessions used client TLS.
	first, err := db.Conn(ctx)
	if err != nil {
		t.Fatalf("acquire first PostgreSQL connection: %v", err)
	}
	t.Cleanup(func() { _ = first.Close() })
	second, err := db.Conn(ctx)
	if err != nil {
		t.Fatalf("acquire additional PostgreSQL connection after inline-PEM cleanup: %v", err)
	}
	t.Cleanup(func() { _ = second.Close() })

	firstPID, firstVersion := assertTLSBackend(t, ctx, first)
	secondPID, secondVersion := assertTLSBackend(t, ctx, second)
	if firstPID == secondPID {
		t.Fatalf("pool returned the same backend twice while both connections were held: pid=%d", firstPID)
	}
	if firstVersion != secondVersion {
		t.Fatalf("PostgreSQL version changed across pool connections: %d and %d", firstVersion, secondVersion)
	}
}

func assertTLSBackend(t *testing.T, ctx context.Context, conn *sql.Conn) (pid int, version int) {
	t.Helper()
	var ssl bool
	var clientDN string
	if err := conn.QueryRowContext(ctx, `
		SELECT pg_backend_pid(), current_setting('server_version_num')::integer,
		       ssl, COALESCE(client_dn, '')
		FROM pg_stat_ssl
		WHERE pid = pg_backend_pid()
	`).Scan(&pid, &version, &ssl, &clientDN); err != nil {
		t.Fatalf("inspect PostgreSQL TLS session: %v", err)
	}
	if version < 180000 || version >= 190000 {
		t.Fatalf("expected PostgreSQL 18, got server_version_num %d", version)
	}
	if !ssl {
		t.Fatal("PostgreSQL connection did not use TLS")
	}
	if !strings.Contains(clientDN, "hichat_tls_test") {
		t.Fatalf("PostgreSQL session presented unexpected client certificate identity %q", clientDN)
	}
	return pid, version
}
