// Package services — short-lived WebSocket connect tickets.
//
// The WebSocket handler used to accept the long-lived JWT access token
// via the `?token=` query parameter because browsers can't set custom
// headers on a WS handshake. Query parameters land in proxy access
// logs, browser history, crash dumps, third-party analytics
// instrumentation — every one of which is a quietly-failing token
// leak. The token was short-lived (24h with the JWT TTL change) but
// still long enough to be replayed for a full session.
//
// WSTicketService issues one-time, ~30-second tickets keyed to a user
// ID. The flow:
//  1. Client POSTs /api/auth/ws-ticket with its Bearer access token.
//  2. Server returns a fresh ticket (random 32 bytes hex), stamped with
//     the caller's token_version at that moment.
//  3. Client opens the WebSocket with `?ticket=<value>`.
//  4. WS handler exchanges the ticket for a userID + token_version, deletes
//     the ticket atomically, and proceeds with the handshake.
//
// The ticket never survives a second handshake (consumed on first
// use) and dies in ~30s anyway, so a leak window is essentially nil.
//
// The token_version stamp (security review 2026-08-01, session-lifecycle
// finding 1) is what lets the WS handshake apply the exact same revocation
// gate to ticket-issued connections as it does to the legacy ?token= path
// (see wsTokenRevoked in ws/handler.go). Without it, a stolen access token
// could be exchanged for a fresh ticket every ~25s indefinitely, riding out
// a "log out from all devices" forever — the ticket path never re-checked
// token_version at all.
package services

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"time"

	"github.com/argeinfina/hichat/pkg/cache"
)

// ErrTicketInvalid is returned when a ticket lookup fails — either the
// ticket is unknown (never issued, already consumed, expired) or
// malformed. The single error value is intentional: differentiating
// "expired" vs "unknown" gives an attacker a useful oracle.
var ErrTicketInvalid = errors.New("invalid or expired ws ticket")

const (
	wsTicketTTL     = 30 * time.Second
	wsTicketCleanup = 1 * time.Minute
	wsTicketBytes   = 32
)

// WSTicketService issues and consumes short-lived WebSocket connect tickets.
type WSTicketService interface {
	// Issue creates a new ticket bound to userID, stamped with tokenVersion
	// (the caller's token_version at mint time — see wsTokenRevoked in
	// ws/handler.go for why this stamp matters). The returned string is
	// safe to include in a URL query parameter (hex-encoded random
	// bytes, no padding or special chars).
	Issue(userID string, tokenVersion int) (string, error)
	// Consume atomically validates the ticket and returns the userID and
	// token_version it was issued for. The ticket is deleted before
	// return — a second call with the same ticket fails with
	// ErrTicketInvalid even if the original TTL hasn't elapsed.
	Consume(ticket string) (userID string, tokenVersion int, err error)
}

// ticketRecord is the value stored per ticket: the userID it was minted for
// and the token_version the user carried at mint time.
type ticketRecord struct {
	userID       string
	tokenVersion int
}

type wsTicketService struct {
	store *cache.TTLCache[string, ticketRecord]
}

// NewWSTicketService creates a WSTicketService backed by an in-memory
// TTL cache. The store is process-local; horizontal-scale deployments
// behind a sticky-session LB are unaffected, but a round-robin LB
// would require sharing the store (Redis, etc.) — left for a future
// rev when the deployment shape actually demands it.
func NewWSTicketService() WSTicketService {
	return &wsTicketService{
		store: cache.New[string, ticketRecord](wsTicketTTL, wsTicketCleanup),
	}
}

func (s *wsTicketService) Issue(userID string, tokenVersion int) (string, error) {
	buf := make([]byte, wsTicketBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	ticket := hex.EncodeToString(buf)
	s.store.Set(ticket, ticketRecord{userID: userID, tokenVersion: tokenVersion})
	return ticket, nil
}

func (s *wsTicketService) Consume(ticket string) (string, int, error) {
	if ticket == "" {
		return "", 0, ErrTicketInvalid
	}
	rec, ok := s.store.Get(ticket)
	if !ok {
		return "", 0, ErrTicketInvalid
	}
	// One-shot: delete immediately so a captured ticket can't be
	// replayed on a second handshake before the TTL fires.
	s.store.Delete(ticket)
	return rec.userID, rec.tokenVersion, nil
}
