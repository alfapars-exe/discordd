package pkg

import (
	"errors"
	"fmt"
	"testing"
)

func TestErrText_NilIsSafe(t *testing.T) {
	// ErrorCtx documents err as optional, so a nil must not panic.
	if got := ErrText(nil); got != "" {
		t.Fatalf("ErrText(nil) = %q, want empty string", got)
	}
}

func TestErrText_RedactsDSNCredential(t *testing.T) {
	// Shape of a real go-libsql connect failure: the driver echoes the DSN.
	err := fmt.Errorf("failed to create user: %w",
		errors.New("dial libsql://db-org.turso.io?authToken=eyJhbGciOiJFZERTQSJ9.secret: connection refused"))

	got := ErrText(err)

	if want := "authToken=***"; !contains(got, want) {
		t.Errorf("ErrText() = %q, want it to contain %q", got, want)
	}
	if contains(got, "eyJhbGciOiJFZERTQSJ9") {
		t.Errorf("ErrText() leaked the token: %q", got)
	}
	// Redaction must not swallow the diagnostic context around the secret.
	if !contains(got, "failed to create user") || !contains(got, "connection refused") {
		t.Errorf("ErrText() dropped surrounding context: %q", got)
	}
}

func TestErrText_RedactsMidDSNCredential(t *testing.T) {
	// authToken followed by another param: only the value is masked.
	err := errors.New("libsql://db.turso.io?authToken=secret123&mode=ro failed")

	got := ErrText(err)

	if contains(got, "secret123") {
		t.Errorf("ErrText() leaked the token: %q", got)
	}
	if !contains(got, "mode=ro") {
		t.Errorf("ErrText() dropped the trailing param: %q", got)
	}
}

func TestErrText_RedactsRegardlessOfCasing(t *testing.T) {
	for _, dsn := range []string{
		"libsql://db.turso.io?AuthToken=secret123",
		"libsql://db.turso.io?AUTHTOKEN=secret123",
		"libsql://db.turso.io?authtoken=secret123",
	} {
		got := ErrText(errors.New(dsn))
		if contains(got, "secret123") {
			t.Errorf("ErrText(%q) leaked the token: %q", dsn, got)
		}
	}
}

func TestErrText_StopsAtCarriageReturn(t *testing.T) {
	// A CRLF-terminated value must not swallow the rest of the line.
	got := ErrText(errors.New("authToken=secret123\r\nnext line kept"))

	if contains(got, "secret123") {
		t.Errorf("ErrText() leaked the token: %q", got)
	}
	if !contains(got, "next line kept") {
		t.Errorf("ErrText() swallowed text after the CRLF: %q", got)
	}
}

func TestErrText_PassesThroughCleanErrors(t *testing.T) {
	err := errors.New("UNIQUE constraint failed: users.username")

	if got, want := ErrText(err), "UNIQUE constraint failed: users.username"; got != want {
		t.Errorf("ErrText() = %q, want %q", got, want)
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (haystack == needle || indexOf(haystack, needle) >= 0)
}

func indexOf(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}
