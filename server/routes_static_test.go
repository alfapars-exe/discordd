package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestTrustedLiveKitWSSource(t *testing.T) {
	tests := []struct {
		name string
		url  string
		want string
	}{
		{name: "exact IPv4 origin", url: "ws://127.0.0.1:7880", want: "ws://127.0.0.1:7880"},
		{name: "default ws port is explicit", url: "ws://localhost", want: "ws://localhost:80"},
		{name: "IPv6 origin", url: "ws://[::1]:7880", want: "ws://[::1]:7880"},
		{name: "path does not widen origin", url: "ws://localhost/rtc", want: "ws://localhost:80"},
		{name: "local hostname case is normalized", url: "ws://LOCALHOST:7880", want: "ws://localhost:7880"},
		{name: "secure ws is already covered by existing policy", url: "wss://livekit.example.test", want: ""},
		{name: "remote hostname must use wss", url: "ws://livekit.example.test:7880", want: ""},
		{name: "remote IPv4 must use wss", url: "ws://192.0.2.20:7880", want: ""},
		{name: "remote IPv6 must use wss", url: "ws://[2001:db8::20]:7880", want: ""},
		{name: "empty", url: "", want: ""},
		{name: "wrong scheme", url: "https://livekit.example.test", want: ""},
		{name: "userinfo", url: "ws://user:pass@livekit.example.test:7880", want: ""},
		{name: "malformed port", url: "ws://livekit.example.test:not-a-port", want: ""},
		{name: "out of range port", url: "ws://livekit.example.test:65536", want: ""},
		{name: "trailing empty port", url: "ws://livekit.example.test:", want: ""},
		{name: "query", url: "ws://livekit.example.test?token=ignored", want: ""},
		{name: "fragment", url: "ws://livekit.example.test#ignored", want: ""},
		{name: "CRLF injection", url: "ws://livekit.example.test\r\nconnect-src *", want: ""},
		{name: "unsafe authority characters", url: "ws://livekit.example.test;connect-src", want: ""},
		{name: "whitespace", url: "ws://livekit.example.test /rtc", want: ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := trustedLiveKitWSSource(tt.url); got != tt.want {
				t.Fatalf("trustedLiveKitWSSource(%q) = %q, want %q", tt.url, got, tt.want)
			}
		})
	}
}

func TestSecurityHeaders_AddsOnlyTrustedLiveKitWSOrigin(t *testing.T) {
	var called bool
	handler := securityHeaders(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}), "ws://127.0.0.1:7880")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/", nil))
	if !called || response.Code != http.StatusNoContent {
		t.Fatalf("wrapped handler called=%v status=%d, want called=true status=%d", called, response.Code, http.StatusNoContent)
	}
	policy := response.Header().Get("Content-Security-Policy")
	for _, want := range []string{
		"default-src 'self'",
		"script-src 'self' 'wasm-unsafe-eval' blob:",
		"connect-src 'self' wss: https: ws://127.0.0.1:7880;",
		"media-src 'self' blob:",
		"worker-src 'self' blob:",
		"frame-ancestors 'none'",
		"frame-src 'none'",
		"object-src 'none'",
		"base-uri 'self'",
		"form-action 'self'",
	} {
		if !strings.Contains(policy, want) {
			t.Errorf("CSP missing %q: %s", want, policy)
		}
	}
	if strings.Contains(policy, " ws:;") || strings.Contains(policy, "ws://attacker.example") {
		t.Fatalf("CSP broadened to an untrusted WebSocket source: %s", policy)
	}
	if got := response.Header().Get("X-Frame-Options"); got != "DENY" {
		t.Errorf("X-Frame-Options = %q, want DENY", got)
	}
}

func TestSecurityHeaders_InvalidLiveKitURLDoesNotAddWSOrigin(t *testing.T) {
	handler := securityHeaders(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}), "ws://livekit.example.test\r\nconnect-src *")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/", nil))
	policy := response.Header().Get("Content-Security-Policy")
	if strings.Contains(policy, "ws://") {
		t.Fatalf("invalid configured URL added a WebSocket source: %s", policy)
	}
	if !strings.Contains(policy, "connect-src 'self' wss: https:;") {
		t.Fatalf("invalid configured URL must retain baseline connect-src: %s", policy)
	}
}
