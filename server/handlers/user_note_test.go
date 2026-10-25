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
	"github.com/argeinfina/hichat/testutil"
)

func newUserNoteHandler(notes *testutil.MockUserNoteRepo) *UserNoteHandler {
	users := &testutil.MockUserRepo{GetByIDFn: func(_ context.Context, id string) (*models.User, error) {
		if id == "ghost" {
			return nil, pkg.ErrNotFound
		}
		return &models.User{ID: id}, nil
	}}
	return NewUserNoteHandler(services.NewUserNoteService(notes, users))
}

func noteRequest(method, target, body string) *http.Request {
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, target, nil)
	} else {
		r = httptest.NewRequest(method, target, strings.NewReader(body))
	}
	r.SetPathValue("userId", target[strings.LastIndex(target, "/users/")+7:strings.LastIndex(target, "/note")])
	return r.WithContext(context.WithValue(r.Context(), UserContextKey, &models.User{ID: "alice"}))
}

func TestUserNoteHandler_GetAndSet(t *testing.T) {
	notes := &testutil.MockUserNoteRepo{}
	h := newUserNoteHandler(notes)

	rec := httptest.NewRecorder()
	h.Get(rec, noteRequest(http.MethodGet, "/api/users/bob/note", ""))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"note":""`) || !strings.Contains(rec.Body.String(), `"updated_at":null`) {
		t.Errorf("Get(empty) = %d %s, want note \"\" / updated_at null", rec.Code, rec.Body.String())
	}

	var stored struct{ owner, target, note string }
	notes.UpsertFn = func(_ context.Context, owner, target, note string) (string, error) {
		stored.owner, stored.target, stored.note = owner, target, note
		return "2026-03-03T00:00:00Z", nil
	}
	rec = httptest.NewRecorder()
	h.Set(rec, noteRequest(http.MethodPut, "/api/users/bob/note", `{"note":" met at the meetup "}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("Set = %d %s", rec.Code, rec.Body.String())
	}
	if stored.owner != "alice" || stored.target != "bob" || stored.note != "met at the meetup" {
		t.Errorf("stored = %+v, want owner alice, target bob, trimmed note", stored)
	}
	if !strings.Contains(rec.Body.String(), `"updated_at":"2026-03-03T00:00:00Z"`) {
		t.Errorf("body = %s, want the upsert timestamp", rec.Body.String())
	}

	deleted := false
	notes.DeleteFn = func(_ context.Context, _, _ string) error { deleted = true; return nil }
	rec = httptest.NewRecorder()
	h.Set(rec, noteRequest(http.MethodPut, "/api/users/bob/note", `{"note":""}`))
	if rec.Code != http.StatusOK || !deleted || !strings.Contains(rec.Body.String(), `"updated_at":null`) {
		t.Errorf("Set(empty) = %d %s (deleted %v), want 200 with the row cleared", rec.Code, rec.Body.String(), deleted)
	}

	rec = httptest.NewRecorder()
	h.Set(rec, noteRequest(http.MethodPut, "/api/users/ghost/note", `{"note":"x"}`))
	if rec.Code != http.StatusNotFound {
		t.Errorf("Set(unknown target) = %d, want 404", rec.Code)
	}

	rec = httptest.NewRecorder()
	h.Set(rec, noteRequest(http.MethodPut, "/api/users/bob/note", `{"note":"a\u200bb"}`))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("Set(steering char) = %d, want 400", rec.Code)
	}

	rec = httptest.NewRecorder()
	h.Set(rec, noteRequest(http.MethodPut, "/api/users/bob/note", `{broken`))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("Set(malformed) = %d, want 400", rec.Code)
	}
}
