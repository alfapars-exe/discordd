package database

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestPostgresConnectionCategoriesDoNotExposeDriverDetails(t *testing.T) {
	for _, item := range []struct {
		err  error
		want string
	}{
		{context.DeadlineExceeded, "network_timeout"},
		{&net.DNSError{Err: "private host and credential", Name: "private"}, "dns_lookup"},
		{&net.OpError{Op: "dial", Err: errors.New("private address and password")}, "network_connection"},
		{&tls.CertificateVerificationError{Err: x509.UnknownAuthorityError{}}, "tls_certificate"},
		{&pgconn.PgError{Code: "28P01", Message: "private password"}, "authentication"},
		{&pgconn.PgError{Code: "3D000", Message: "private database"}, "database_missing"},
		{&pgconn.PgError{Code: "53300", Message: "private host"}, "server_unavailable"},
		{&pgconn.PgError{Code: "XX000", Message: "private server detail"}, "server_rejected"},
		{errors.New("private connection string"), "connection_unknown"},
	} {
		if got := postgresConnectFailureCode(fmt.Errorf("sensitive wrapper: %w", item.err)); got != item.want {
			t.Errorf("category = %q, want %q", got, item.want)
		}
	}
}

type postgresTestPinger struct {
	errors []error
	calls  int
}

func (p *postgresTestPinger) PingContext(context.Context) error {
	index := p.calls
	p.calls++
	if index < len(p.errors) {
		return p.errors[index]
	}
	return nil
}

func TestPostgresStartupRetriesOnlyTransientFailuresAndHonorsCancellation(t *testing.T) {
	networkFailure := &net.OpError{Op: "dial", Err: errors.New("connection refused")}
	pinger := &postgresTestPinger{errors: []error{networkFailure, networkFailure}}
	var delays []time.Duration
	if err := pingPostgresWithRetry(context.Background(), pinger, func(_ context.Context, delay time.Duration) error {
		delays = append(delays, delay)
		return nil
	}); err != nil || pinger.calls != 3 || len(delays) != 2 || delays[0] != 500*time.Millisecond || delays[1] != time.Second {
		t.Fatalf("transient retry result: err=%v calls=%d delays=%v", err, pinger.calls, delays)
	}
	for _, failure := range []error{
		&tls.CertificateVerificationError{Err: x509.UnknownAuthorityError{}},
		&pgconn.PgError{Code: "28P01"},
		errors.New("unexpected driver failure"),
	} {
		pinger = &postgresTestPinger{errors: []error{failure}}
		err := pingPostgresWithRetry(context.Background(), pinger, func(context.Context, time.Duration) error {
			t.Fatal("permanent failure must not be retried")
			return nil
		})
		if !errors.Is(err, failure) || pinger.calls != 1 {
			t.Fatalf("permanent failure result: err=%v calls=%d", err, pinger.calls)
		}
	}
	pinger = &postgresTestPinger{errors: []error{networkFailure, networkFailure, networkFailure}}
	if err := pingPostgresWithRetry(context.Background(), pinger, func(context.Context, time.Duration) error { return nil }); !errors.Is(err, networkFailure) || pinger.calls != 3 {
		t.Fatalf("retry limit result: err=%v calls=%d", err, pinger.calls)
	}
	ctx, cancel := context.WithCancel(context.Background())
	pinger = &postgresTestPinger{errors: []error{networkFailure}}
	err := pingPostgresWithRetry(ctx, pinger, func(ctx context.Context, delay time.Duration) error {
		cancel()
		return waitPostgresRetry(ctx, delay)
	})
	if !errors.Is(err, context.Canceled) || pinger.calls != 1 {
		t.Fatalf("cancellation result: err=%v calls=%d", err, pinger.calls)
	}
}
