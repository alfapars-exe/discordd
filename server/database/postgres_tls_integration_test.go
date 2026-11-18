package database

import (
	"context"
	"database/sql"
	"net/url"
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

	// These failures use the same live endpoint as the successful handshakes,
	// rather than merely rejecting incomplete configuration before connecting.
	t.Run("rejects_untrusted_server_chain", func(t *testing.T) {
		// A valid client leaf is not the server's trust anchor. Both client
		// credentials stay valid, so rejection must be certificate verification.
		t.Setenv("HICHAT_PG_CA_PEM", os.Getenv("HICHAT_PG_CERT_PEM"))
		rejected, err := OpenPostgres(ctx, dsn)
		if rejected != nil {
			_ = rejected.Close()
			t.Fatal("untrusted server chain returned a usable pool")
		}
		if err == nil || !strings.Contains(err.Error(), "(tls_certificate)") {
			t.Fatalf("expected live server certificate rejection, got %v", err)
		}
	})
	t.Run("rejects_client_identity_mismatch", func(t *testing.T) {
		other, err := url.Parse(dsn)
		if err != nil {
			t.Fatal("invalid integration DSN")
		}
		password, _ := other.User.Password()
		other.User = url.UserPassword("hichat_tls_other_identity", password)
		rejected, err := OpenPostgres(ctx, other.String())
		if rejected != nil {
			_ = rejected.Close()
			t.Fatal("mismatched client identity returned a usable pool")
		}
		if err == nil || !strings.Contains(err.Error(), "(authentication)") {
			t.Fatalf("expected live client identity rejection, got %v", err)
		}
	})
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
