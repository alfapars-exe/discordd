package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
)

type spamHandlerStore struct {
	user, cursor, status string
	limit, calls         int
	err                  error
	changed              bool
}

func (s *spamHandlerStore) Record(context.Context, *models.SpamInboxEntry) error {
	s.calls++
	return s.err
}
func (s *spamHandlerStore) Decide(_ context.Context, user, kind, message, revision, status string) (bool, error) {
	s.calls++
	s.user, s.status = user, status
	return s.changed, s.err
}
func (s *spamHandlerStore) List(context.Context, string, int) ([]models.SpamInboxEntry, error) {
	return nil, s.err
}
func (s *spamHandlerStore) Page(_ context.Context, user, cursor string, limit int) (*models.SpamInboxPage, error) {
	s.calls++
	s.user, s.cursor, s.limit = user, cursor, limit
	return &models.SpamInboxPage{Entries: []models.SpamInboxEntry{}, NextCursor: "next"}, s.err
}
func (s *spamHandlerStore) Decisions(ctx context.Context, user, cursor string, limit int) (*models.SpamInboxPage, error) {
	return s.Page(ctx, user, cursor, limit)
}
func spamHandlerRequest(body string, user *models.User) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/api/users/me/spam?cursor=anchor&limit=2", strings.NewReader(body))
	if user != nil {
		r = r.WithContext(context.WithValue(r.Context(), UserContextKey, user))
	}
	return r
}
func TestSpamHandlerAuthentication(t *testing.T) {
	h := NewSpamInboxHandler(nil)
	for _, method := range []http.HandlerFunc{h.List, h.Decisions, h.Record, h.Restore, h.Dismiss} {
		for _, user := range []*models.User{nil, {ID: "bot", IsBot: true}} {
			w := httptest.NewRecorder()
			method(w, spamHandlerRequest(`{}`, user))
			if w.Code != http.StatusUnauthorized {
				t.Fatalf("unauthenticated response: %d", w.Code)
			}
		}
	}
}
func TestSpamHandlerRejectsInvalidBodiesBeforeStorage(t *testing.T) {
	s := &spamHandlerStore{}
	h := NewSpamInboxHandler(services.NewSpamInboxService(s, nil, nil, nil, nil, nil))
	for _, body := range []string{"", "null", `{}`, `{"unknown":true}`, `{"user_id":"foreign"}`, `{} {}`, `{"message_id":"` + strings.Repeat("x", 8200) + `"}`} {
		for _, method := range []http.HandlerFunc{h.Record, h.Restore, h.Dismiss} {
			w := httptest.NewRecorder()
			method(w, spamHandlerRequest(body, &models.User{ID: "reader"}))
			if w.Code != http.StatusBadRequest {
				t.Fatalf("body %q: %d", body[:min(len(body), 40)], w.Code)
			}
		}
	}
	if s.calls != 0 {
		t.Fatalf("invalid input reached storage: %d", s.calls)
	}
}
func TestSpamHandlerDecisionOwnershipAndErrors(t *testing.T) {
	s := &spamHandlerStore{changed: true}
	h := NewSpamInboxHandler(services.NewSpamInboxService(s, nil, nil, nil, nil, nil))
	body := `{"source_kind":"dm","channel_id":"private","message_id":"message","revision":"original"}`
	for _, test := range []struct {
		err     error
		changed bool
		code    int
	}{{nil, true, 200}, {nil, false, 404}, {pkg.ErrConflict, false, 409}, {pkg.ErrForbidden, false, 403}} {
		s.err, s.changed = test.err, test.changed
		w := httptest.NewRecorder()
		h.Dismiss(w, spamHandlerRequest(body, &models.User{ID: "reader"}))
		if w.Code != test.code || s.user != "reader" || s.status != "dismissed" {
			t.Fatalf("decision: %d %+v", w.Code, s)
		}
	}
}
func TestSpamHandlerListAndDecisionsUseAuthenticatedScope(t *testing.T) {
	s := &spamHandlerStore{}
	h := NewSpamInboxHandler(services.NewSpamInboxService(s, nil, nil, nil, nil, nil))
	for _, method := range []http.HandlerFunc{h.List, h.Decisions} {
		w := httptest.NewRecorder()
		method(w, spamHandlerRequest("", &models.User{ID: "reader"}))
		if w.Code != 200 || s.user != "reader" || s.cursor != "anchor" || s.limit != 2 || !strings.Contains(w.Body.String(), `"next_cursor":"next"`) {
			t.Fatalf("list: %d %s %+v", w.Code, w.Body.String(), s)
		}
	}
}
