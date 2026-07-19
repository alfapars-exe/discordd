package ws

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// checkOriginFor exercises the CheckOrigin closure exactly as
// gorilla/websocket does at Upgrade time, without dragging the full
// hijack machinery in.
func checkOriginFor(origin, host string) bool {
	req := httptest.NewRequest(http.MethodGet, "/ws", nil)
	req.Host = host
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	return upgrader.CheckOrigin(req)
}

func TestCheckOrigin_appHichatAcceptedViaAllowlist(t *testing.T) {
	prev := AllowedOrigins
	t.Cleanup(func() { AllowedOrigins = prev })
	AllowedOrigins = []string{"app://hichat"}

	if !checkOriginFor("app://hichat", "api.example") {
		t.Fatal("app://hichat rejected — Electron renderer can't connect WS")
	}
}

func TestCheckOrigin_nullAndFileStillAcceptedForLegacyElectron(t *testing.T) {
	// T1.4 moved production Electron to app://, but users on older
	// installer builds still send "null" or "file://". WS accepts them
	// because every WS connection requires a one-shot ticket regardless
	// (see the AllowedOrigins loop comment above); dropping the fallback
	// now would break every un-updated desktop client immediately.
	prev := AllowedOrigins
	t.Cleanup(func() { AllowedOrigins = prev })
	AllowedOrigins = []string{"app://hichat"}

	if !checkOriginFor("null", "api.example") {
		t.Error("origin=null rejected — old Electron builds can't upgrade WS")
	}
	if !checkOriginFor("file://", "api.example") {
		t.Error("origin=file:// rejected — old Electron builds can't upgrade WS")
	}
}

func TestCheckOrigin_rejectsUnlistedOrigin(t *testing.T) {
	prev := AllowedOrigins
	t.Cleanup(func() { AllowedOrigins = prev })
	AllowedOrigins = []string{"app://hichat"}

	if checkOriginFor("https://evil.example", "api.example") {
		t.Fatal("evil origin accepted — WS upgrade should have been rejected")
	}
}

func TestCheckOrigin_emptyOriginAllowedAsSameOrigin(t *testing.T) {
	// Non-browser clients (Go tests, curl, self-hosted bots) omit Origin;
	// upgrading them is fine because the ticket check still gates entry.
	prev := AllowedOrigins
	t.Cleanup(func() { AllowedOrigins = prev })
	AllowedOrigins = nil

	if !checkOriginFor("", "api.example") {
		t.Error("empty origin rejected — breaks server-to-server WS clients")
	}
}
