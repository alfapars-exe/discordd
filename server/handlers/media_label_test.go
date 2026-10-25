package handlers

import (
	"context"
	"encoding/json"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type mediaHandlerStore struct {
	entry *models.MediaLabel
	err   error
}

func (s *mediaHandlerStore) Set(_ context.Context, entry *models.MediaLabel) error {
	copy := *entry
	s.entry = &copy
	return s.err
}
func (s *mediaHandlerStore) Get(_ context.Context, entry *models.MediaLabel) (*models.MediaLabel, error) {
	if s.entry != nil && s.entry.UserID == entry.UserID {
		return s.entry, nil
	}
	return nil, nil
}
func (s *mediaHandlerStore) Delete(_ context.Context, entry *models.MediaLabel) error {
	if s.entry != nil && s.entry.UserID == entry.UserID {
		s.entry = nil
	}
	return s.err
}

func TestMediaLabelHandlerReturnsVersionConflict(t *testing.T) {
	store := &mediaHandlerStore{err: pkg.ErrConflict}
	h := NewMediaLabelHandler(services.NewMediaLabelService(store, mediaHandlerAccess{}))
	body := `{"source_kind":"dm","channel_id":"private","message_id":"message","revision":"original","fingerprint":"` + strings.Repeat("a", 64) + `","label":"sexual","expected_version":"legacy"}`
	for _, handler := range []http.HandlerFunc{h.Set, h.Delete} {
		w := httptest.NewRecorder()
		handler(w, spamHandlerRequest(body, &models.User{ID: "owner"}))
		if w.Code != 409 || !strings.Contains(w.Body.String(), `"code":"CONFLICT"`) {
			t.Fatalf("conflict: %d %s", w.Code, w.Body.String())
		}
	}
}

type mediaHandlerAccess struct{}

func (mediaHandlerAccess) RecipientRevision(context.Context, string, string, string, string) (string, error) {
	return "original", nil
}

func TestMediaLabelHandlerRoundTripAndPrivateResponse(t *testing.T) {
	store := &mediaHandlerStore{}
	h := NewMediaLabelHandler(services.NewMediaLabelService(store, mediaHandlerAccess{}))
	body := `{"source_kind":"dm","channel_id":"private","message_id":"message","revision":"original","fingerprint":"` + strings.Repeat("a", 64) + `","label":"sexual","expected_version":""}`
	w := httptest.NewRecorder()
	h.Set(w, spamHandlerRequest(body, &models.User{ID: "owner"}))
	if w.Code != 200 || store.entry == nil || store.entry.UserID != "owner" {
		t.Fatalf("set: %d %+v", w.Code, store.entry)
	}
	for _, owner := range []string{"owner", "other"} {
		r := spamHandlerRequest("", &models.User{ID: owner})
		r.URL.RawQuery = "source_kind=dm&channel_id=private&message_id=message&revision=original&fingerprint=" + strings.Repeat("a", 64)
		w = httptest.NewRecorder()
		h.Get(w, r)
		if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("get: %d %v", w.Code, w.Header())
		}
		var response struct {
			Data struct {
				Annotation *models.MediaLabel `json:"annotation"`
			} `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		if (response.Data.Annotation != nil) != (owner == "owner") {
			t.Fatalf("owner isolation: %s %s", owner, w.Body.String())
		}
		if strings.Contains(w.Body.String(), "user_id") {
			t.Fatal("private owner identifier serialized")
		}
	}
	w = httptest.NewRecorder()
	h.Delete(w, spamHandlerRequest(body, &models.User{ID: "owner"}))
	if w.Code != 200 || store.entry != nil {
		t.Fatalf("delete: %d %+v", w.Code, store.entry)
	}
}

func TestMediaLabelHandlerRejectsMissingOwnerBotsAndUnsafeBodies(t *testing.T) {
	h := NewMediaLabelHandler(services.NewMediaLabelService(nil, nil))
	for _, method := range []http.HandlerFunc{h.Get, h.Set, h.Delete} {
		for _, user := range []*models.User{nil, {ID: "bot", IsBot: true}} {
			w := httptest.NewRecorder()
			method(w, spamHandlerRequest("{}", user))
			if w.Code != 401 {
				t.Fatalf("auth status=%d", w.Code)
			}
		}
	}
	for _, body := range []string{"null", "{}", `{"user_id":"foreign"}`, `{"media":"plaintext"}`, `{} {}`, `{"source_kind":"dm","channel_id":"private","message_id":"message","revision":"original","fingerprint":"` + strings.Repeat("a", 64) + `","label":"sexual"}`, `{"label":"` + strings.Repeat("x", 4200) + `"}`} {
		for _, method := range []http.HandlerFunc{h.Set, h.Delete} {
			w := httptest.NewRecorder()
			method(w, spamHandlerRequest(body, &models.User{ID: "owner"}))
			if w.Code != 400 {
				t.Fatalf("invalid body status=%d", w.Code)
			}
		}
	}
}
