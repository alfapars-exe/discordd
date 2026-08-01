package ws

import (
	"testing"

	"github.com/argeinfina/hichat/models"
)

// TestWsScopeRejected locks the WebSocket half of the scoped-media-token
// change. The hichat_media cookie is a media-scoped token; a leaked one must
// not be usable to open a WebSocket (which would hand the holder the full
// realtime event stream — messages, DMs, presence). Only unscoped access
// tokens may authenticate an upgrade.
func TestWsScopeRejected(t *testing.T) {
	tests := []struct {
		name       string
		scope      string
		wantReject bool
	}{
		{
			name:       "unscoped access token is the only accepted kind",
			scope:      "",
			wantReject: false,
		},
		{
			name:       "media-scoped token cannot open a WebSocket",
			scope:      models.TokenScopeMedia,
			wantReject: true,
		},
		{
			name:       "any future scope is rejected until explicitly allowed",
			scope:      "some-future-scope",
			wantReject: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := wsScopeRejected(tt.scope); got != tt.wantReject {
				t.Errorf("wsScopeRejected(%q) = %v, want %v", tt.scope, got, tt.wantReject)
			}
		})
	}
}

// TestWsTokenRevoked locks the fix for security review finding 1
// (2026-08-01): the WS ticket path used to be EXEMPT from this gate because
// synthesized ticket claims carried no token_version, so a stolen access
// token could be exchanged for a fresh ~30s ticket forever and ride out a
// "log out from all devices" indefinitely. The fix stamps the ticket with
// the caller's token_version at Issue time (services/ws_ticket_service.go)
// and threads it through resolveConnectionAuth, so wsTokenRevoked no longer
// takes a fromTicket flag at all — both callers now present a real
// token_version and are compared identically.
func TestWsTokenRevoked(t *testing.T) {
	tests := []struct {
		name        string
		claimTV     int
		userTV      int
		wantRevoked bool
	}{
		{
			name:        "stale credential below current version is revoked",
			claimTV:     2,
			userTV:      3,
			wantRevoked: true,
		},
		{
			name:        "current credential is accepted",
			claimTV:     3,
			userTV:      3,
			wantRevoked: false,
		},
		{
			name:        "credential ahead of user version is accepted",
			claimTV:     4,
			userTV:      3,
			wantRevoked: false,
		},
		{
			name:        "both zero (never revoked) is accepted",
			claimTV:     0,
			userTV:      0,
			wantRevoked: false,
		},
		{
			name: "ticket minted before a bump (claimTV=0, user since revoked) is now" +
				" revoked — the exact regression this fix closes",
			claimTV:     0,
			userTV:      1,
			wantRevoked: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := wsTokenRevoked(tt.claimTV, tt.userTV); got != tt.wantRevoked {
				t.Errorf("wsTokenRevoked(claimTV=%d, userTV=%d) = %v, want %v",
					tt.claimTV, tt.userTV, got, tt.wantRevoked)
			}
		})
	}
}
