package database

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"log/slog"
	"net"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

type postgresPinger interface {
	PingContext(context.Context) error
}

func waitPostgresRetry(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// Only transient connection failures are retried. Authentication and certificate
// validation failures retain their fail-closed behavior and are never weakened.
func pingPostgresWithRetry(ctx context.Context, conn postgresPinger, wait func(context.Context, time.Duration) error) error {
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		err = conn.PingContext(ctx)
		if err == nil {
			return nil
		}
		category := postgresConnectFailureCode(err)
		if attempt == 2 || (category != "network_timeout" && category != "network_connection" && category != "server_unavailable") {
			return err
		}
		slog.Warn("PostgreSQL startup connection retry", "attempt", attempt+2, "category", category)
		if err := wait(ctx, time.Duration(attempt+1)*500*time.Millisecond); err != nil {
			return err
		}
	}
	return err
}

// postgresConnectFailureCode exposes a fixed diagnostic category, never the
// driver's error text: connection errors can contain credentials and PEM paths.
func postgresConnectFailureCode(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "28P01", "28000":
			return "authentication"
		case "3D000":
			return "database_missing"
		case "53300", "57P03":
			return "server_unavailable"
		default:
			return "server_rejected"
		}
	}
	var certErr *tls.CertificateVerificationError
	var authorityErr x509.UnknownAuthorityError
	var hostnameErr x509.HostnameError
	var invalidCertErr x509.CertificateInvalidError
	if errors.As(err, &certErr) || errors.As(err, &authorityErr) || errors.As(err, &hostnameErr) || errors.As(err, &invalidCertErr) {
		return "tls_certificate"
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return "dns_lookup"
	}
	var networkErr net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &networkErr) && networkErr.Timeout()) {
		return "network_timeout"
	}
	var opErr *net.OpError
	if errors.As(err, &opErr) {
		return "network_connection"
	}
	return "connection_unknown"
}
