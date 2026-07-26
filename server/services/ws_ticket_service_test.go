package services

import (
	"errors"
	"testing"
)

// Characterizes the one-time WS connect ticket: the whole point is that a
// ticket leaked into a proxy log or browser history cannot be replayed, so the
// consumed-exactly-once property is the security invariant under test.

func TestWSTicket_IssueThenConsumeOnce(t *testing.T) {
	svc := NewWSTicketService()

	ticket, err := svc.Issue("user-1")
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if len(ticket) != wsTicketBytes*2 {
		t.Errorf("ticket length = %d, want %d hex chars for %d random bytes", len(ticket), wsTicketBytes*2, wsTicketBytes)
	}

	uid, err := svc.Consume(ticket)
	if err != nil {
		t.Fatalf("Consume: %v", err)
	}
	if uid != "user-1" {
		t.Errorf("Consume returned %q, want user-1", uid)
	}

	// One-shot: the same ticket must not resolve a second time even though its
	// 30s TTL has not elapsed.
	if _, err := svc.Consume(ticket); !errors.Is(err, ErrTicketInvalid) {
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
		if _, err := svc.Consume(ticket); !errors.Is(err, ErrTicketInvalid) {
			t.Errorf("%s: Consume err = %v, want ErrTicketInvalid", name, err)
		}
	}
}

func TestWSTicket_IssueProducesDistinctTickets(t *testing.T) {
	svc := NewWSTicketService()
	seen := make(map[string]bool, 200)
	for i := 0; i < 200; i++ {
		ticket, err := svc.Issue("u")
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
	alice, _ := svc.Issue("alice")
	bob, _ := svc.Issue("bob")

	if uid, _ := svc.Consume(bob); uid != "bob" {
		t.Errorf("bob's ticket resolved to %q, want bob", uid)
	}
	if uid, _ := svc.Consume(alice); uid != "alice" {
		t.Errorf("alice's ticket resolved to %q, want alice", uid)
	}
}
