package ws

import "testing"

// TestWsTokenRevoked locks the fix for the ticket-path token_version lockout.
//
// Regression: the WS ticket path synthesizes claims with no token_version
// (int zero). The revocation gate `claimTV < userTV` therefore rejected
// every user whose token_version had ever been bumped (password change,
// logout-from-all-devices, refresh-token-reuse) with "token revoked" — even
// though they could still authenticate over HTTP. The ticket is already
// gated at mint time, so the ticket path must be exempt.
func TestWsTokenRevoked(t *testing.T) {
	tests := []struct {
		name        string
		fromTicket  bool
		claimTV     int
		userTV      int
		wantRevoked bool
	}{
		{
			name:        "ticket path exempt when user token_version was bumped (the lockout regression)",
			fromTicket:  true,
			claimTV:     0, // synthesized ticket claims carry no tv
			userTV:      3, // user changed password / logged out everywhere
			wantRevoked: false,
		},
		{
			name:        "ticket path exempt when versions match",
			fromTicket:  true,
			claimTV:     0,
			userTV:      0,
			wantRevoked: false,
		},
		{
			name:        "legacy token path: stale token below current version is revoked",
			fromTicket:  false,
			claimTV:     2,
			userTV:      3,
			wantRevoked: true,
		},
		{
			name:        "legacy token path: current token is accepted",
			fromTicket:  false,
			claimTV:     3,
			userTV:      3,
			wantRevoked: false,
		},
		{
			name:        "legacy token path: token ahead of user version is accepted",
			fromTicket:  false,
			claimTV:     4,
			userTV:      3,
			wantRevoked: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := wsTokenRevoked(tt.fromTicket, tt.claimTV, tt.userTV); got != tt.wantRevoked {
				t.Errorf("wsTokenRevoked(fromTicket=%v, claimTV=%d, userTV=%d) = %v, want %v",
					tt.fromTicket, tt.claimTV, tt.userTV, got, tt.wantRevoked)
			}
		})
	}
}
