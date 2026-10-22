// SavedHandler wired to the REAL services.SavedService over testutil mocks,
// so the status codes the client contract pins (403 non-member channel, 403
// foreign DM, 200-idempotent POST, 404 foreign PATCH/DELETE, 400 mixed
// refs) are asserted end-to-end through the handler → service path.
package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/testutil"
)

type savedHandlerFixture struct {
	saved *testutil.MockSavedRepo
	perms *testutil.MockChannelPermResolver
	h     *SavedHandler
}

func newSavedHandlerFixture() *savedHandlerFixture {
	f := &savedHandlerFixture{saved: &testutil.MockSavedRepo{}, perms: &testutil.MockChannelPermResolver{}}
	msgs := &testutil.MockMessageRepo{GetByIDFn: func(_ context.Context, id string) (*models.Message, error) {
		if id != "m1" {
			return nil, pkg.ErrNotFound
		}
		return &models.Message{ID: "m1", ChannelID: "ch1"}, nil
	}}
	chans := &testutil.MockChannelRepo{GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
		return &models.Channel{ID: id, ServerID: "srv"}, nil
	}}
	dm := &testutil.MockDMRepo{
		GetMessageByIDFn: func(_ context.Context, id string) (*models.DMMessage, error) {
			if id != "d1" {
				return nil, pkg.ErrNotFound
			}
			return &models.DMMessage{ID: "d1", DMChannelID: "dm1"}, nil
		},
		GetChannelByIDFn: func(_ context.Context, id string) (*models.DMChannel, error) {
			return &models.DMChannel{ID: id, User1ID: "alice", User2ID: "bob"}, nil
		},
	}
	f.perms.ResolveChannelPermissionsFn = func(_ context.Context, userID, _ string) (models.Permission, error) {
		if userID == "outsider" {
			return 0, nil
		}
		return models.PermViewChannel | models.PermReadMessages, nil
	}
	f.saved.CreateFn = func(_ context.Context, s *models.SavedMessage) error { s.ID = "saved-new"; return nil }
	f.saved.GetByIDFn = func(_ context.Context, userID, id string) (*models.SavedMessage, error) {
		return &models.SavedMessage{ID: id, UserID: userID}, nil
	}
	f.h = NewSavedHandler(services.NewSavedService(f.saved, msgs, chans, dm, f.perms))
	return f
}

func savedRequest(method, target, userID, body string) *http.Request {
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, target, nil)
	} else {
		r = httptest.NewRequest(method, target, strings.NewReader(body))
	}
	user := &models.User{ID: userID, Username: userID}
	return r.WithContext(context.WithValue(r.Context(), UserContextKey, user))
}

func TestSavedHandler_Create_StatusCodes(t *testing.T) {
	cases := []struct {
		name   string
		user   string
		body   string
		setup  func(f *savedHandlerFixture)
		status int
	}{
		{"new channel bookmark is 201", "alice", `{"message_id":"m1"}`, nil, http.StatusCreated},
		{"non-member channel is 403", "outsider", `{"message_id":"m1"}`, nil, http.StatusForbidden},
		{"foreign DM is 403", "carol", `{"dm_message_id":"d1"}`, nil, http.StatusForbidden},
		{"member DM is 201", "bob", `{"dm_message_id":"d1"}`, nil, http.StatusCreated},
		{"unknown message is 404", "alice", `{"message_id":"ghost"}`, nil, http.StatusNotFound},
		{"both refs is 400", "alice", `{"message_id":"m1","dm_message_id":"d1"}`, nil, http.StatusBadRequest},
		{"no ref is 400", "alice", `{}`, nil, http.StatusBadRequest},
		{"malformed body is 400", "alice", `{not json`, nil, http.StatusBadRequest},
		{"already saved is 200 with the existing row", "alice", `{"message_id":"m1"}`, func(f *savedHandlerFixture) {
			f.saved.FindByRefFn = func(_ context.Context, userID, messageID, _ string) (*models.SavedMessage, error) {
				return &models.SavedMessage{ID: "existing", UserID: userID, MessageID: &messageID}, nil
			}
		}, http.StatusOK},
		{"limit reached is 400 saved_limit_reached", "alice", `{"message_id":"m1"}`, func(f *savedHandlerFixture) {
			f.saved.CountFn = func(_ context.Context, _ string) (int, error) { return models.SavedMessagesLimit, nil }
		}, http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newSavedHandlerFixture()
			if tc.setup != nil {
				tc.setup(f)
			}
			rec := httptest.NewRecorder()
			f.h.Create(rec, savedRequest(http.MethodPost, "/api/users/me/saved", tc.user, tc.body))
			if rec.Code != tc.status {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, tc.status, rec.Body.String())
			}
			var env struct {
				Data  json.RawMessage `json:"data"`
				Error string          `json:"error"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
				t.Fatalf("decode envelope: %v", err)
			}
			switch tc.name {
			case "already saved is 200 with the existing row":
				if !strings.Contains(string(env.Data), `"id":"existing"`) {
					t.Errorf("data = %s, want the existing row", env.Data)
				}
			case "limit reached is 400 saved_limit_reached":
				if !strings.Contains(env.Error, "saved_limit_reached") {
					t.Errorf("error = %q, want saved_limit_reached", env.Error)
				}
			}
		})
	}
}

func TestSavedHandler_UpdateNoteAndDelete_ForeignIs404(t *testing.T) {
	f := newSavedHandlerFixture()
	f.saved.UpdateNoteFn = func(_ context.Context, userID, id string, _ *string) (bool, error) { return id == "mine", nil }
	f.saved.DeleteFn = func(_ context.Context, userID, id string) (bool, error) { return id == "mine", nil }

	for _, tc := range []struct {
		method, id string
		body       string
		status     int
	}{
		{http.MethodPatch, "theirs", `{"note":"x"}`, http.StatusNotFound},
		{http.MethodPatch, "mine", `{"note":"x"}`, http.StatusOK},
		{http.MethodPatch, "mine", `{"note":null}`, http.StatusOK},
		{http.MethodPatch, "mine", `{"note":"a\u202eb"}`, http.StatusBadRequest},
		{http.MethodDelete, "theirs", "", http.StatusNotFound},
		{http.MethodDelete, "mine", "", http.StatusOK},
	} {
		t.Run(tc.method+" "+tc.id+" "+tc.body, func(t *testing.T) {
			req := savedRequest(tc.method, "/api/users/me/saved/"+tc.id, "alice", tc.body)
			req.SetPathValue("id", tc.id)
			rec := httptest.NewRecorder()
			if tc.method == http.MethodPatch {
				f.h.UpdateNote(rec, req)
			} else {
				f.h.Delete(rec, req)
			}
			if rec.Code != tc.status {
				t.Errorf("status = %d, want %d (body %s)", rec.Code, tc.status, rec.Body.String())
			}
		})
	}
}

func TestSavedHandler_List_ClampsLimitAndPassesCursor(t *testing.T) {
	f := newSavedHandlerFixture()
	var gotBefore string
	var gotLimit int
	f.saved.ListFn = func(_ context.Context, _, before string, limit int) ([]models.SavedMessage, error) {
		gotBefore, gotLimit = before, limit
		return []models.SavedMessage{}, nil
	}
	rec := httptest.NewRecorder()
	f.h.List(rec, savedRequest(http.MethodGet, "/api/users/me/saved?before=s9&limit=999", "alice", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (body %s)", rec.Code, rec.Body.String())
	}
	if gotBefore != "s9" || gotLimit != models.SavedPageMax+1 {
		t.Errorf("repo List(before %q, limit %d), want (s9, max+1 = %d)", gotBefore, gotLimit, models.SavedPageMax+1)
	}
	if !strings.Contains(rec.Body.String(), `"saved":[]`) || !strings.Contains(rec.Body.String(), `"has_more":false`) || !strings.Contains(rec.Body.String(), `"next_before":null`) {
		t.Errorf("body = %s, want an empty saved array, has_more false and next_before null", rec.Body.String())
	}

	rec = httptest.NewRecorder()
	f.h.ListIDs(rec, savedRequest(http.MethodGet, "/api/users/me/saved/ids", "alice", ""))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"message_ids":[]`) || !strings.Contains(rec.Body.String(), `"dm_message_ids":[]`) {
		t.Errorf("ListIDs = %d %s, want empty arrays", rec.Code, rec.Body.String())
	}
}

// TestHistoryCursor_MutuallyExclusive — ?before=, ?around= and ?after= on
// the message history endpoints reject any combination with a 400.
func TestHistoryCursor_MutuallyExclusive(t *testing.T) {
	for _, target := range []string{
		"/x?before=a&around=b",
		"/x?before=a&after=b",
		"/x?around=a&after=b",
		"/x?before=a&around=b&after=c",
	} {
		req := httptest.NewRequest(http.MethodGet, target, nil)
		rec := httptest.NewRecorder()
		if _, ok := parseHistoryCursor(rec, req.URL.Query()); ok || rec.Code != http.StatusBadRequest {
			t.Errorf("%s: ok=%v status=%d, want a 400 rejection", target, ok, rec.Code)
		}
	}
	for _, target := range []string{"/x", "/x?before=a", "/x?around=a", "/x?after=a"} {
		req := httptest.NewRequest(http.MethodGet, target, nil)
		rec := httptest.NewRecorder()
		if _, ok := parseHistoryCursor(rec, req.URL.Query()); !ok {
			t.Errorf("%s: rejected, want accepted", target)
		}
	}
}
