package services

import (
	"errors"
	"testing"
)

// Characterizes the one-time WS connect ticket: the whole point is that a
// ticket leaked into a proxy log or browser history cannot be replayed, so the
// consumed-exactly-once property is the security invariant under test.
//
// Also characterizes the token_version stamp added by the 2026-08-01
// security review (session-lifecycle finding 1): Issue records the caller's
// token_version at mint time, and Consume must hand it back unchanged so the
// WS handshake can apply the same revocation gate the legacy ?token= path
// uses (see wsTokenRevoked in ws/handler.go).

func TestWSTicket_IssueThenConsumeOnce(t *testing.T) {
	svc := NewWSTicketService()

	ticket, err := svc.Issue("user-1", 0)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if len(ticket) != wsTicketBytes*2 {
		t.Errorf("ticket length = %d, want %d hex chars for %d random bytes", len(ticket), wsTicketBytes*2, wsTicketBytes)
	}

	uid, tv, err := svc.Consume(ticket)
	if err != nil {
		t.Fatalf("Consume: %v", err)
	}
	if uid != "user-1" {
		t.Errorf("Consume returned %q, want user-1", uid)
	}
	if tv != 0 {
		t.Errorf("Consume returned token_version %d, want 0", tv)
	}

	// One-shot: the same ticket must not resolve a second time even though its
	// 30s TTL has not elapsed.
	if _, _, err := svc.Consume(ticket); !errors.Is(err, ErrTicketInvalid) {
		t.Errorf("second Consume err = %v, want ErrTicketInvalid", err)
	}
}

func TestWSTicket_ConsumeInvalid(t *testing.T) {
	svc := NewWSTicketService()
	cases := map[string]string{
		"empty":            "",
		"never issued":     "deadbeefdeadbeef",
		"malformed random": "not-a-real-ticket",
	}
	for name, ticket := range cases {
		if _, _, err := svc.Consume(ticket); !errors.Is(err, ErrTicketInvalid) {
			t.Errorf("%s: Consume err = %v, want ErrTicketInvalid", name, err)
		}
	}
}

func TestWSTicket_IssueProducesDistinctTickets(t *testing.T) {
	svc := NewWSTicketService()
	seen := make(map[string]bool, 200)
	for i := 0; i < 200; i++ {
		ticket, err := svc.Issue("u", 0)
		if err != nil {
			t.Fatalf("Issue: %v", err)
		}
		if seen[ticket] {
			t.Fatalf("Issue produced a duplicate ticket: %q", ticket)
		}
		seen[ticket] = true
	}
}

func TestWSTicket_ConsumeReturnsTheBoundUser(t *testing.T) {
	svc := NewWSTicketService()
	alice, _ := svc.Issue("alice", 1)
	bob, _ := svc.Issue("bob", 2)

	if uid, _, _ := svc.Consume(bob); uid != "bob" {
		t.Errorf("bob's ticket resolved to %q, want bob", uid)
	}
	if uid, _, _ := svc.Consume(alice); uid != "alice" {
		t.Errorf("alice's ticket resolved to %q, want alice", uid)
	}
}

// TestWSTicket_ConsumeReturnsTheStampedTokenVersion is the primary evidence
// for security review finding 1: Issue's tokenVersion argument must survive
// unchanged through Consume, per-ticket, so a caller who was on token_version
// 1 at mint time is never silently upgraded to a later stamp just because
// another ticket for a different (or bumped) user was issued afterward.
func TestWSTicket_ConsumeReturnsTheStampedTokenVersion(t *testing.T) {
	svc := NewWSTicketService()

	staleTicket, err := svc.Issue("user-1", 1) // minted before a token_version bump
	if err != nil {
		t.Fatalf("Issue (stale): %v", err)
	}
	freshTicket, err := svc.Issue("user-1", 2) // minted after the bump
	if err != nil {
		t.Fatalf("Issue (fresh): %v", err)
	}

	if _, tv, err := svc.Consume(staleTicket); err != nil || tv != 1 {
		t.Errorf("stale ticket Consume = (tv=%d, err=%v), want (tv=1, err=nil)", tv, err)
	}
	if _, tv, err := svc.Consume(freshTicket); err != nil || tv != 2 {
		t.Errorf("fresh ticket Consume = (tv=%d, err=%v), want (tv=2, err=nil)", tv, err)
	}
}
