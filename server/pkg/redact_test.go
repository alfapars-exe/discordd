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

func TestErrText_RedactsWebSocketTicket(t *testing.T) {
	// Shape of a WebSocket upgrade failure that echoes the request URL,
	// e.g. `?ticket=<one-time credential>`.
	err := fmt.Errorf("websocket upgrade failed: %w",
		errors.New("dial wss://hichat.example.com/ws?ticket=abc123def456: connection refused"))

	got := ErrText(err)

	if want := "ticket=***"; !contains(got, want) {
		t.Errorf("ErrText() = %q, want it to contain %q", got, want)
	}
	if contains(got, "abc123def456") {
		t.Errorf("ErrText() leaked the ticket: %q", got)
	}
	if !contains(got, "websocket upgrade failed") || !contains(got, "connection refused") {
		t.Errorf("ErrText() dropped surrounding context: %q", got)
	}
}

func TestErrText_PassesThroughCleanErrors(t *testing.T) {
	err := errors.New("UNIQUE constraint failed: users.username")

	if got, want := ErrText(err), "UNIQUE constraint failed: users.username"; got != want {
		t.Errorf("ErrText() = %q, want %q", got, want)
	}
}

func TestErrText_RedactsRemainingSecretParams(t *testing.T) {
	for _, tc := range []struct {
		name   string
		input  string
		secret string
		want   string
	}{
		{"password", "connect failed: password=hunter2 host=db1", "hunter2", "password=***"},
		{"apikey", "upstream error: apikey=sk_live_abc123 retrying", "sk_live_abc123", "apikey=***"},
		{"api_key", "upstream error: api_key=sk_live_abc123 retrying", "sk_live_abc123", "api_key=***"},
		{"secret", "config load failed: secret=topsecretvalue", "topsecretvalue", "secret=***"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := ErrText(errors.New(tc.input))
			if contains(got, tc.secret) {
				t.Errorf("ErrText(%q) leaked the secret: %q", tc.input, got)
			}
			if !contains(got, tc.want) {
				t.Errorf("ErrText(%q) = %q, want it to contain %q", tc.input, got, tc.want)
			}
		})
	}
}

func TestErrText_RedactsWithMultiByteUTF8Context(t *testing.T) {
	// The client-side bug this guards against came from lowercasing the whole
	// string before scanning for the key: JS toLowerCase() can change a
	// string's length for some multi-byte characters, shifting byte offsets
	// out from under the match. redactParam never lowercases s itself (it
	// only compares candidate substrings via strings.EqualFold), so this
	// must not happen here — but lock it in with a test.
	err := errors.New("İşlem başarısız: authToken=secret123&mode=ro")

	got := ErrText(err)

	if contains(got, "secret123") {
		t.Errorf("ErrText() leaked the token: %q", got)
	}
	if !contains(got, "authToken=***") {
		t.Errorf("ErrText() = %q, want it to contain %q", got, "authToken=***")
	}
	if !contains(got, "mode=ro") {
		t.Errorf("ErrText() dropped the trailing param: %q", got)
	}
	if !contains(got, "İşlem başarısız") {
		t.Errorf("ErrText() mangled the surrounding UTF-8 text: %q", got)
	}
}

func TestRedactSecrets_ExportedDirectly(t *testing.T) {
	// RedactSecrets is called directly by callers outside pkg (e.g. the
	// client-log handler) that redact free text before persisting it, not
	// just error strings routed through ErrText.
	got := RedactSecrets("upstream call failed: token=abc123 retrying")

	if contains(got, "abc123") {
		t.Errorf("RedactSecrets() leaked the token: %q", got)
	}
	if !contains(got, "token=***") {
		t.Errorf("RedactSecrets() = %q, want it to contain %q", got, "token=***")
	}
	if !contains(got, "retrying") {
		t.Errorf("RedactSecrets() dropped surrounding context: %q", got)
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
