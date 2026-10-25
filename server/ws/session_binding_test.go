package ws

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

type sessionTicketStub struct {
	stubTicketConsumer
	sessionID string
}

func (s sessionTicketStub) ConsumeSession(string) (string, int, string, error) {
	return s.userID, s.tokenVersion, s.sessionID, s.err
}

type sessionValidatorStub struct {
	stubTokenValidator
	revoked bool
	seenID  string
}

func (s *sessionValidatorStub) ValidateSession(_ context.Context, _ string, id string) error {
	s.seenID = id
	if s.revoked {
		return errors.New("revoked")
	}
	return nil
}

func TestSessionBoundTicketCheckedBeforeUpgrade(t *testing.T) {
	validator := &sessionValidatorStub{revoked: true}
	h := &Handler{hub: NewHub(), tokenValidator: validator, ticketConsumer: sessionTicketStub{stubTicketConsumer: stubTicketConsumer{userID: "u1", tokenVersion: 2}, sessionID: "bound-session"}}
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/ws?ticket=fixture", nil)
	h.HandleConnection(w, r)
	if w.Code != http.StatusUnauthorized || validator.seenID != "bound-session" {
		t.Fatalf("status=%d sid=%s", w.Code, validator.seenID)
	}
}

func TestDisconnectSessionDoesNotRemoveAnotherSession(t *testing.T) {
	h := NewHub()
	h.unregister = make(chan *Client, 4)
	a := &Client{userID: "u1", sessionID: "a", done: make(chan struct{})}
	b := &Client{userID: "u1", sessionID: "b", done: make(chan struct{})}
	c := &Client{userID: "u2", sessionID: "a", done: make(chan struct{})}
	h.addClient(a)
	h.addClient(b)
	h.addClient(c)
	h.DisconnectSession("u1", "a")
	if len(h.unregister) != 1 {
		t.Fatalf("disconnect count=%d", len(h.unregister))
	}
	if target := <-h.unregister; target != a {
		t.Fatal("another session targeted")
	}
}
