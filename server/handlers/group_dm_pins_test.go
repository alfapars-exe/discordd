package handlers

import (
	"context"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
	"net/http"
	"net/http/httptest"
	"testing"
)

type groupPinsServiceStub struct {
	services.GroupDMService
	calls   int
	failure error
}

func (s *groupPinsServiceStub) SetMessagePinned(_ context.Context, g, u, m string, p bool) error {
	s.calls++
	if g != "g" || u != "reader" || m != "m" {
		return pkg.ErrBadRequest
	}
	return s.failure
}
func (s *groupPinsServiceStub) ListPinnedMessages(_ context.Context, g, u string) ([]models.GroupDMMessage, error) {
	s.calls++
	return []models.GroupDMMessage{}, s.failure
}
func TestGroupPinsHTTPAccountAndMembership(t *testing.T) {
	for _, action := range []string{"list", "pin", "unpin"} {
		for _, scenario := range []string{"ok", "unauthenticated", "account", "forbidden"} {
			t.Run(action+"/"+scenario, func(t *testing.T) {
				svc := &groupPinsServiceStub{}
				h := &GroupDMHandler{service: svc}
				url := "/api/group-dms/g/pinned"
				if scenario == "account" {
					url += "?expected_user_id=other"
				}
				r := httptest.NewRequest(http.MethodGet, url, nil)
				r.SetPathValue("groupId", "g")
				r.SetPathValue("messageId", "m")
				if scenario != "unauthenticated" {
					r = r.WithContext(context.WithValue(r.Context(), UserContextKey, &models.User{ID: "reader"}))
				}
				if scenario == "forbidden" {
					svc.failure = pkg.ErrForbidden
				}
				w := httptest.NewRecorder()
				switch action {
				case "list":
					h.ListPinnedMessages(w, r)
				case "pin":
					h.PinMessage(w, r)
				case "unpin":
					h.UnpinMessage(w, r)
				}
				want := 200
				if scenario == "unauthenticated" {
					want = 401
				}
				if scenario == "account" {
					want = 409
				}
				if scenario == "forbidden" {
					want = 403
				}
				if w.Code != want {
					t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
				}
				if (scenario == "unauthenticated" || scenario == "account") && svc.calls != 0 {
					t.Fatalf("unexpected service calls=%d", svc.calls)
				}
			})
		}
	}
}
