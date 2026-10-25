package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
)

type aggregateCountFixture struct {
	services.NotificationService
	owner string
	fail  bool
}

func (f *aggregateCountFixture) CountUnreadSummary(_ context.Context, owner string) (models.NotificationUnreadCounts, error) {
	f.owner = owner
	if f.fail {
		return models.NotificationUnreadCounts{}, pkg.ErrNotFound
	}
	return models.NotificationUnreadCounts{UnreadCount: 115, BadgeUnreadCount: 55}, nil
}

type legacyCountFixture struct {
	services.NotificationService
	owner string
}

func (f *legacyCountFixture) CountUnread(_ context.Context, owner string) (int, error) {
	f.owner = owner
	return 12, nil
}
func countRequest(owner string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/api/users/me/notifications/count?user_id=foreign", nil)
	if owner != "" {
		r = r.WithContext(context.WithValue(r.Context(), UserContextKey, &models.User{ID: owner}))
	}
	return r
}
func decodeCountResponse(t *testing.T, w *httptest.ResponseRecorder) models.NotificationUnreadCounts {
	t.Helper()
	var response struct {
		Data models.NotificationUnreadCounts `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	return response.Data
}
func TestNotificationCountHandlerAuthoritativeAndLegacyFields(t *testing.T) {
	aggregate := &aggregateCountFixture{}
	w := httptest.NewRecorder()
	NewNotificationHandler(aggregate).Count(w, countRequest("viewer"))
	if w.Code != http.StatusOK || aggregate.owner != "viewer" {
		t.Fatalf("count auth/code: %d %q", w.Code, aggregate.owner)
	}
	counts := decodeCountResponse(t, w)
	if counts.UnreadCount != 115 || counts.BadgeUnreadCount != 55 {
		t.Fatalf("aggregate fields=%+v", counts)
	}
	legacy := &legacyCountFixture{}
	w = httptest.NewRecorder()
	NewNotificationHandler(legacy).Count(w, countRequest("viewer"))
	counts = decodeCountResponse(t, w)
	if w.Code != http.StatusOK || legacy.owner != "viewer" || counts.UnreadCount != 12 || counts.BadgeUnreadCount != 12 {
		t.Fatalf("legacy fields=%+v code=%d", counts, w.Code)
	}
}
func TestNotificationCountHandlerNeverFallsBackOnAggregateFailure(t *testing.T) {
	aggregate := &aggregateCountFixture{fail: true}
	w := httptest.NewRecorder()
	NewNotificationHandler(aggregate).Count(w, countRequest("viewer"))
	if w.Code != http.StatusNotFound {
		t.Fatalf("aggregate failure hidden: %d", w.Code)
	}
	w = httptest.NewRecorder()
	NewNotificationHandler(aggregate).Count(w, countRequest(""))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("missing actor=%d", w.Code)
	}
}
