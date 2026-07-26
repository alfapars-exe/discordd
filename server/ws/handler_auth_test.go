package ws

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/argeinfina/hichat/models"
)

// This file is a CHARACTERIZATION test: it locks the exact HTTP status codes
// (*Handler).HandleConnection writes on each pre-upgrade reject branch. Only
// the two pure helpers (wsScopeRejected, wsTokenRevoked) were covered before;
// the reject matrix that runs before upgrader.Upgrade was untested. Pinning
// these codes lets an upcoming split of HandleConnection into sub-functions be
// proven behaviour-preserving. A green run means the assertions already match
// current behaviour — that is the point of a characterization net.
//
// Scope note: only the REJECT branches are exercised. httptest.NewRecorder
// cannot hijack the connection, so the success/upgrade path is deliberately
// out of scope here.

// --- minimal stubs for the interfaces HandleConnection depends on ---

type stubTicketConsumer struct {
	userID string
	err    error
}

func (s stubTicketConsumer) Consume(ticket string) (string, error) {
	return s.userID, s.err
}

type stubTokenValidator struct {
	claims *models.TokenClaims
	err    error
}

func (s stubTokenValidator) ValidateAccessToken(token string) (*models.TokenClaims, error) {
	return s.claims, s.err
}

type stubBanChecker struct {
	banned bool
	err    error
}

func (s stubBanChecker) IsBanned(ctx context.Context, userID string) (bool, error) {
	return s.banned, s.err
}

type stubUserInfoProvider struct {
	user *models.User
	err  error
}

func (s stubUserInfoProvider) GetByID(ctx context.Context, id string) (*models.User, error) {
	return s.user, s.err
}

// okUser is a valid, non-banned user with a matching token_version.
func okUser() *models.User {
	return &models.User{
		ID:               "u1",
		Username:         "alice",
		TokenVersion:     0,
		IsPlatformBanned: false,
		PrefStatus:       models.UserStatusOnline,
	}
}

// TestHandleConnection_RejectMatrix pins the status code each reject branch of
// HandleConnection writes before the WebSocket upgrade. Table-driven; each row
// wires only the Handler fields its scenario reaches. voiceStatesProvider,
// serverListProvider, muteChecker, channelMuteChecker and botValidator stay
// nil — they are only touched after a successful upgrade.
func TestHandleConnection_RejectMatrix(t *testing.T) {
	tests := []struct {
		name     string
		handler  *Handler
		target   string
		legacy   bool // set HICHAT_ALLOW_LEGACY_WS_TOKEN=1 for this row
		wantCode int
	}{
		{
			name: "1 ticket consume error -> 401 invalid ticket",
			handler: &Handler{
				hub:            NewHub(),
				ticketConsumer: stubTicketConsumer{err: errors.New("expired ticket")},
			},
			target:   "/ws?ticket=x",
			wantCode: http.StatusUnauthorized,
		},
		{
			name: "2 legacy token path disabled (env unset) -> 401",
			handler: &Handler{
				hub: NewHub(),
			},
			target:   "/ws?token=x",
			legacy:   false,
			wantCode: http.StatusUnauthorized,
		},
		{
			name: "3 no ticket, no token -> 401 missing ticket",
			handler: &Handler{
				hub: NewHub(),
			},
			target:   "/ws",
			wantCode: http.StatusUnauthorized,
		},
		{
			name: "4 legacy allowed, token validate error -> 401 invalid token",
			handler: &Handler{
				hub:            NewHub(),
				tokenValidator: stubTokenValidator{err: errors.New("bad signature")},
			},
			target:   "/ws?token=x",
			legacy:   true,
			wantCode: http.StatusUnauthorized,
		},
		{
			name: "5 legacy allowed, media-scoped token -> 401 scope rejected",
			handler: &Handler{
				hub: NewHub(),
				tokenValidator: stubTokenValidator{claims: &models.TokenClaims{
					UserID: "u1",
					Scope:  models.TokenScopeMedia,
				}},
			},
			target:   "/ws?token=x",
			legacy:   true,
			wantCode: http.StatusUnauthorized,
		},
		{
			name: "6 ticket ok, user lookup error -> 401 user not found",
			handler: &Handler{
				hub:              NewHub(),
				ticketConsumer:   stubTicketConsumer{userID: "u1"},
				userInfoProvider: stubUserInfoProvider{err: errors.New("no such user")},
			},
			target:   "/ws?ticket=x",
			wantCode: http.StatusUnauthorized,
		},
		{
			name: "7 legacy allowed, token_version stale -> 401 token revoked",
			handler: &Handler{
				hub: NewHub(),
				tokenValidator: stubTokenValidator{claims: &models.TokenClaims{
					UserID:       "u1",
					Username:     "alice",
					TokenVersion: 2,
				}},
				userInfoProvider: stubUserInfoProvider{user: &models.User{
					ID:           "u1",
					Username:     "alice",
					TokenVersion: 3,
					PrefStatus:   models.UserStatusOnline,
				}},
			},
			target:   "/ws?token=x",
			legacy:   true,
			wantCode: http.StatusUnauthorized,
		},
		{
			name: "8 ticket ok, platform banned -> 403 account suspended",
			handler: &Handler{
				hub:            NewHub(),
				ticketConsumer: stubTicketConsumer{userID: "u1"},
				userInfoProvider: stubUserInfoProvider{user: &models.User{
					ID:               "u1",
					Username:         "alice",
					IsPlatformBanned: true,
					PrefStatus:       models.UserStatusOnline,
				}},
			},
			target:   "/ws?ticket=x",
			wantCode: http.StatusForbidden,
		},
		{
			name: "9 ticket ok, server-scoped banned -> 403 banned",
			handler: &Handler{
				hub:              NewHub(),
				ticketConsumer:   stubTicketConsumer{userID: "u1"},
				userInfoProvider: stubUserInfoProvider{user: okUser()},
				banChecker:       stubBanChecker{banned: true},
			},
			target:   "/ws?ticket=x",
			wantCode: http.StatusForbidden,
		},
		{
			name: "10 ticket ok, ban check error -> 500 internal error",
			handler: &Handler{
				hub:              NewHub(),
				ticketConsumer:   stubTicketConsumer{userID: "u1"},
				userInfoProvider: stubUserInfoProvider{user: okUser()},
				banChecker:       stubBanChecker{err: errors.New("db down")},
			},
			target:   "/ws?ticket=x",
			wantCode: http.StatusInternalServerError,
		},
		{
			// Guard: nil ticketConsumer with no token still lands on the
			// "missing ticket" 401 — the ticket block is skipped entirely
			// when ticketConsumer is nil.
			name: "guard nil ticketConsumer, no token -> 401 missing ticket",
			handler: &Handler{
				hub: NewHub(),
			},
			target:   "/ws",
			wantCode: http.StatusUnauthorized,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.legacy {
				t.Setenv("HICHAT_ALLOW_LEGACY_WS_TOKEN", "1")
			}
			req := httptest.NewRequest(http.MethodGet, tt.target, nil)
			rec := httptest.NewRecorder()

			tt.handler.HandleConnection(rec, req)

			if rec.Code != tt.wantCode {
				t.Errorf("HandleConnection(%q) status = %d, want %d (body: %q)",
					tt.target, rec.Code, tt.wantCode, rec.Body.String())
			}
		})
	}
}
