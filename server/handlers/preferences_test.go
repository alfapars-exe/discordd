package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/services"
)

type handlerPreferencesRepo struct {
	err    error
	writes int
	userID string
	data   json.RawMessage
}

func (p *handlerPreferencesRepo) Get(_ context.Context, userID string) (*models.UserPreferences, error) {
	p.userID = userID
	if p.err != nil {
		return nil, p.err
	}
	data := p.data
	if data == nil {
		data = json.RawMessage(`{}`)
	}
	return &models.UserPreferences{UserID: userID, Data: data}, nil
}
func (p *handlerPreferencesRepo) Upsert(ctx context.Context, userID string, data json.RawMessage) (*models.UserPreferences, error) {
	p.writes++
	p.data = data
	return p.Get(ctx, userID)
}

func preferencesRequest(method, body string, authenticated bool) *http.Request {
	req := httptest.NewRequest(method, "/api/users/me/preferences", strings.NewReader(body))
	if authenticated {
		req = req.WithContext(context.WithValue(req.Context(), UserContextKey, &models.User{ID: "request-user"}))
	}
	return req
}

func TestPreferencesHandlerValidPartialPatchAndMetadata(t *testing.T) {
	repo := &handlerPreferencesRepo{}
	handler := NewPreferencesHandler(services.NewPreferencesService(repo))
	w := httptest.NewRecorder()
	handler.Update(w, preferencesRequest(http.MethodPatch, `{"data":{"voice_settings":{"masterVolume":75,"inputDevice":"device-secret"}}}`, true))
	if w.Code != http.StatusOK {
		t.Fatalf("patch: %d %s", w.Code, w.Body.String())
	}
	if repo.userID != "request-user" || repo.writes != 1 {
		t.Fatalf("wrong user/write count: %+v", repo)
	}
	var response struct {
		Success bool                   `json:"success"`
		Data    models.UserPreferences `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if !response.Success || response.Data.SchemaVersion != 1 || string(response.Data.Data) != `{"voice_settings":{"masterVolume":75}}` {
		t.Fatalf("bad response: %s", w.Body.String())
	}
	w = httptest.NewRecorder()
	handler.Get(w, preferencesRequest(http.MethodGet, "", true))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"schema_version":1`) || strings.Contains(w.Body.String(), "device-secret") {
		t.Fatalf("get: %d %s", w.Code, w.Body.String())
	}
}

func TestPreferencesHandlerRejectsInvalidEnvelopesAndFields(t *testing.T) {
	tests := []struct {
		name, body string
		status     int
	}{
		{"empty", ``, 400}, {"null envelope", `null`, 400}, {"missing data", `{}`, 400},
		{"null data", `{"data":null}`, 400}, {"array data", `{"data":[]}`, 400},
		{"unknown root", `{"data":{"unknown":true}}`, 400},
		{"nested null", `{"data":{"voice_settings":{"masterVolume":null}}}`, 400},
		{"wrong type", `{"data":{"sidebar_expanded":"false"}}`, 400},
		{"range", `{"data":{"accessibility":{"chatFontSize":100}}}`, 400},
		{"two documents", `{"data":{}} {"data":{}}`, 400},
		{"trailing junk", `{"data":{}} garbage`, 400},
		{"oversized envelope", `{"ignored":"` + strings.Repeat("x", models.MaxPreferencesPatchBytes+1024) + `","data":{}}`, 413},
		{"oversized whitespace", `{"data":{}}` + strings.Repeat(" ", models.MaxPreferencesPatchBytes+1024), 413},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			repo := &handlerPreferencesRepo{}
			handler := NewPreferencesHandler(services.NewPreferencesService(repo))
			w := httptest.NewRecorder()
			handler.Update(w, preferencesRequest(http.MethodPatch, tt.body, true))
			if w.Code != tt.status || repo.writes != 0 || !strings.Contains(w.Body.String(), `"success":false`) {
				t.Fatalf("invalid request: status=%d writes=%d body=%s", w.Code, repo.writes, w.Body.String())
			}
		})
	}
}

func TestPreferencesHandlerAuthenticationAndDatabaseErrors(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodPatch} {
		for _, authenticated := range []bool{false, true} {
			repo := &handlerPreferencesRepo{err: errors.New("database failure /private/file.db")}
			handler := NewPreferencesHandler(services.NewPreferencesService(repo))
			w := httptest.NewRecorder()
			req := preferencesRequest(method, `{"data":{"theme":"ocean"}}`, authenticated)
			if method == http.MethodGet {
				handler.Get(w, req)
			} else {
				handler.Update(w, req)
			}
			expected := http.StatusUnauthorized
			if authenticated {
				expected = http.StatusInternalServerError
			}
			if w.Code != expected || !strings.Contains(w.Body.String(), `"success":false`) || strings.Contains(w.Body.String(), "private") {
				t.Fatalf("failure response: %d %s", w.Code, w.Body.String())
			}
			if !authenticated && (repo.writes != 0 || repo.userID != "") {
				t.Fatal("unauthenticated request reached repository")
			}
		}
	}
}

func TestPreferencesHandlerAccountAffinity(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodPatch} {
		for _, expected := range []string{"", "request-user", "different-account"} {
			t.Run(method+"/"+expected, func(t *testing.T) {
				repo := &handlerPreferencesRepo{}
				handler := NewPreferencesHandler(services.NewPreferencesService(repo))
				body, err := json.Marshal(models.UpdatePreferencesRequest{ExpectedUserID: expected, Data: json.RawMessage(`{"theme":"ocean"}`)})
				if err != nil {
					t.Fatal(err)
				}
				req := preferencesRequest(method, string(body), true)
				query := req.URL.Query()
				query.Set("expected_user_id", expected)
				req.URL.RawQuery = query.Encode()
				w := httptest.NewRecorder()
				if method == http.MethodGet {
					handler.Get(w, req)
				} else {
					handler.Update(w, req)
				}
				if expected == "different-account" {
					if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "PREFERENCES_ACCOUNT_MISMATCH") || repo.writes != 0 || repo.userID != "" {
						t.Fatalf("stale account reached repository: code=%d writes=%d user=%s response=%s", w.Code, repo.writes, repo.userID, w.Body.String())
					}
				} else if w.Code != http.StatusOK || repo.userID != "request-user" {
					t.Fatalf("compatible account request failed: %d %s", w.Code, w.Body.String())
				}
			})
		}
	}
}

func TestPreferencesHandlerSQLiteIntegration(t *testing.T) {
	migrations, err := fs.Sub(database.EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatal(err)
	}
	db, err := database.New(filepath.Join(t.TempDir(), "preferences.db"), migrations)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if _, err := db.Conn.Exec(`INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)`, "request-user", "prefs-http", "x"); err != nil {
		t.Fatal(err)
	}
	handler := NewPreferencesHandler(services.NewPreferencesService(repository.NewSQLitePreferencesRepo(database.NewRetryingQuerier(db.Conn))))
	w := httptest.NewRecorder()
	handler.Get(w, preferencesRequest(http.MethodGet, "", true))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"data":{}`) || !strings.Contains(w.Body.String(), `"schema_version":1`) {
		t.Fatalf("missing row did not produce defaults: %d %s", w.Code, w.Body.String())
	}
	for _, patch := range []string{
		`{"data":{"voice_settings":{"masterVolume":80,"userVolumes":{"alice":50}}}}`,
		`{"data":{"voice_settings":{"inputVolume":120,"userVolumes":{"bob":75}}}}`,
	} {
		w = httptest.NewRecorder()
		handler.Update(w, preferencesRequest(http.MethodPatch, patch, true))
		if w.Code != http.StatusOK {
			t.Fatalf("valid patch failed: %d %s", w.Code, w.Body.String())
		}
	}
	w = httptest.NewRecorder()
	handler.Get(w, preferencesRequest(http.MethodGet, "", true))
	for _, expected := range []string{`"masterVolume":80`, `"inputVolume":120`, `"alice":50`, `"bob":75`} {
		if !strings.Contains(w.Body.String(), expected) {
			t.Fatalf("nested leaf was lost: %s", w.Body.String())
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{http.MethodGet, http.MethodPatch} {
		w = httptest.NewRecorder()
		req := preferencesRequest(method, `{"data":{"theme":"ocean"}}`, true)
		if method == http.MethodGet {
			handler.Get(w, req)
		} else {
			handler.Update(w, req)
		}
		if w.Code != http.StatusInternalServerError || !strings.Contains(w.Body.String(), `"success":false`) {
			t.Fatalf("closed SQLite database returned success: %d %s", w.Code, w.Body.String())
		}
	}
}
