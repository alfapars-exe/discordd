// EmojiHandler wired to the REAL services.EmojiService over the in-memory
// testutil.MockEmojiRepo (handlers/saved_test.go pattern), so the upload
// order, the response shape and the status codes are asserted end-to-end.
package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image/color"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg/ratelimit"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/testutil"
)

type emojiHandlerFixture struct {
	repo *testutil.MockEmojiRepo
	dir  string
	h    *EmojiHandler
}

func newEmojiHandlerFixture(t *testing.T, limiter *ratelimit.MessageRateLimiter) *emojiHandlerFixture {
	t.Helper()
	f := &emojiHandlerFixture{repo: &testutil.MockEmojiRepo{}, dir: t.TempDir()}
	svc := services.NewEmojiService(f.repo, &testutil.MockServerRepo{}, &testutil.MockBroadcaster{}, f.dir)
	f.h = NewEmojiHandler(svc, limiter)
	return f
}

// emojiUpload builds a multipart POST with a "file" part plus the given
// text fields, scoped to serverID and userID the way the route middleware
// would leave the context.
func emojiUpload(t *testing.T, serverID, userID string, file []byte, fields map[string]string) *http.Request {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	for k, v := range fields {
		if err := mw.WriteField(k, v); err != nil {
			t.Fatalf("write field: %v", err)
		}
	}
	fw, err := mw.CreateFormFile("file", "kedi.png")
	if err != nil {
		t.Fatalf("create form file: %v", err)
	}
	if _, err := fw.Write(file); err != nil {
		t.Fatalf("write file: %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close multipart: %v", err)
	}
	r := httptest.NewRequest(http.MethodPost, "/api/servers/"+serverID+"/emojis", &body)
	r.Header.Set("Content-Type", mw.FormDataContentType())
	return withEmojiCtx(r, serverID, userID)
}

func withEmojiCtx(r *http.Request, serverID, userID string) *http.Request {
	ctx := context.WithValue(r.Context(), UserContextKey, &models.User{ID: userID, Username: userID})
	if serverID != "" {
		ctx = context.WithValue(ctx, ServerIDContextKey, serverID)
	}
	return r.WithContext(ctx)
}

func errorCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var env struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode error envelope: %v (body %q)", err, rec.Body.String())
	}
	return env.Code
}

func smallPNG(t *testing.T) []byte {
	return encodePNGFixture(t, newSolidRGBA(64, 32, color.RGBA{0xff, 0x80, 0, 0xff}))
}

func TestEmojiHandler_CreateShape(t *testing.T) {
	f := newEmojiHandlerFixture(t, nil)
	rec := httptest.NewRecorder()
	f.h.Create(rec, emojiUpload(t, "srv", "alice", smallPNG(t), map[string]string{
		"display_name": "Şaşkın Kedi",
		"copyable":     "true",
	}))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var got map[string]any
	decodeEnvelope(t, rec, &got)
	for _, k := range []string{"id", "server_id", "name", "display_name", "animated", "url", "animated_url", "copyable", "created_by", "created_at"} {
		if _, ok := got[k]; !ok {
			t.Errorf("response missing %q: %v", k, got)
		}
	}
	id, _ := got["id"].(string)
	if got["name"] != "saskin_kedi" || got["server_id"] != "srv" || got["copyable"] != true ||
		got["animated"] != false || got["animated_url"] != nil || got["created_by"] != "alice" ||
		got["url"] != "/api/uploads/emojis/"+id+".png" {
		t.Errorf("response = %v", got)
	}
	// The stored file is encoder output: a PNG.
	b, err := os.ReadFile(filepath.Join(f.dir, "emojis", id+".png"))
	if err != nil || !bytes.HasPrefix(b, pngMagic) {
		t.Errorf("stored file: err=%v prefix=%x", err, b[:min(len(b), 4)])
	}
}

// TestEmojiHandler_CreateIgnoresServerOwnedFields — the aklama pin: a form
// naming file_url / animated_url / created_by / id must not influence the row.
func TestEmojiHandler_CreateIgnoresServerOwnedFields(t *testing.T) {
	f := newEmojiHandlerFixture(t, nil)
	rec := httptest.NewRecorder()
	f.h.Create(rec, emojiUpload(t, "srv", "alice", smallPNG(t), map[string]string{
		"display_name": "Kedi",
		"file_url":     "/api/uploads/someone_elses_private.png",
		"animated_url": "/api/uploads/other.gif",
		"created_by":   "mallory",
		"id":           "ffffffffffffffff",
		"server_id":    "victim",
	}))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var got models.ServerEmoji
	decodeEnvelope(t, rec, &got)
	if got.ID == "ffffffffffffffff" || got.ServerID != "srv" || got.URL != "/api/uploads/emojis/"+got.ID+".png" ||
		got.AnimatedURL != nil || got.CreatedBy == nil || *got.CreatedBy != "alice" {
		t.Errorf("client-supplied fields leaked into the row: %+v", got)
	}
}

func TestEmojiHandler_CreateRejectsOversizedFile(t *testing.T) {
	f := newEmojiHandlerFixture(t, nil)
	rec := httptest.NewRecorder()
	big := append(smallPNG(t), make([]byte, models.ExpressionMaxUploadBytes)...)
	f.h.Create(rec, emojiUpload(t, "srv", "alice", big, map[string]string{"display_name": "Kedi"}))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if f.repo.Len() != 0 {
		t.Error("oversized upload created a row")
	}
}

func TestEmojiHandler_CreateRateLimited(t *testing.T) {
	f := newEmojiHandlerFixture(t, ratelimit.NewMessageRateLimiter(1, time.Minute, 30*time.Second))
	first := httptest.NewRecorder()
	f.h.Create(first, emojiUpload(t, "srv", "alice", smallPNG(t), map[string]string{"display_name": "Bir"}))
	if first.Code != http.StatusCreated {
		t.Fatalf("first upload status = %d, body %s", first.Code, first.Body.String())
	}
	second := httptest.NewRecorder()
	f.h.Create(second, emojiUpload(t, "srv", "alice", smallPNG(t), map[string]string{"display_name": "Iki"}))
	if second.Code != http.StatusTooManyRequests {
		t.Fatalf("second upload status = %d, want 429", second.Code)
	}
	if second.Header().Get("Retry-After") == "" {
		t.Error("429 without Retry-After")
	}
}

func TestEmojiHandler_CreateErrorCodes(t *testing.T) {
	cases := []struct {
		name   string
		fields map[string]string
		file   []byte
		setup  func(f *emojiHandlerFixture)
		status int
		code   string
	}{
		{"bad name", map[string]string{"display_name": "Kedi", "name": "Bad Name"}, nil, nil, http.StatusBadRequest, "EXPRESSION_NAME_INVALID"},
		{"bad display name", map[string]string{"display_name": "evil‮"}, nil, nil, http.StatusBadRequest, "EXPRESSION_DISPLAY_NAME_INVALID"},
		{"name taken", map[string]string{"display_name": "Kedi"}, nil, func(f *emojiHandlerFixture) {
			f.repo.Put(models.ServerEmoji{ID: "aaaaaaaaaaaaaaaa", ServerID: "srv", Name: "kedi"})
		}, http.StatusConflict, "EXPRESSION_NAME_TAKEN"},
		{"bad copyable", map[string]string{"display_name": "Kedi", "copyable": "yes"}, nil, nil, http.StatusBadRequest, ""},
		{"not an image", map[string]string{"display_name": "Kedi"}, append([]byte("BM"), make([]byte, 52)...), nil, http.StatusBadRequest, "BAD_REQUEST"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newEmojiHandlerFixture(t, nil)
			if tc.setup != nil {
				tc.setup(f)
			}
			file := tc.file
			if file == nil {
				file = smallPNG(t)
			}
			rec := httptest.NewRecorder()
			f.h.Create(rec, emojiUpload(t, "srv", "alice", file, tc.fields))
			if rec.Code != tc.status {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, tc.status, rec.Body.String())
			}
			if tc.code != "" {
				if got := errorCode(t, rec); got != tc.code {
					t.Errorf("code = %q, want %q", got, tc.code)
				}
			}
		})
	}
}

// TestWriteEmojiImageError_AnimatedTooLargeWording — the emoji route must not
// surface the avatar-specific ErrAnimatedTooLarge text.
func TestWriteEmojiImageError_AnimatedTooLargeWording(t *testing.T) {
	rec := httptest.NewRecorder()
	writeEmojiImageError(rec, fmt.Errorf("%w: 999 bytes exceeds 1", ErrAnimatedTooLarge))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	body := rec.Body.String()
	if strings.Contains(body, "avatar") || !strings.Contains(body, emojiAnimatedTooLargeMsg) {
		t.Errorf("body = %s, want the emoji-specific message", body)
	}

	busy := httptest.NewRecorder()
	writeEmojiImageError(busy, fmt.Errorf("%w: ctx", ErrImageBusy))
	if busy.Code != http.StatusServiceUnavailable || busy.Header().Get("Retry-After") == "" {
		t.Errorf("busy: status %d, Retry-After %q", busy.Code, busy.Header().Get("Retry-After"))
	}
}

func TestEmojiHandler_UpdateAndDelete(t *testing.T) {
	f := newEmojiHandlerFixture(t, nil)
	creator := "alice"
	f.repo.Put(models.ServerEmoji{ID: "aaaaaaaaaaaaaaaa", ServerID: "srv", Name: "kedi", DisplayName: "Kedi", CreatedBy: &creator})

	patch := func(serverID, userID, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPatch, "/api/servers/"+serverID+"/emojis/aaaaaaaaaaaaaaaa", strings.NewReader(body))
		r.SetPathValue("emojiId", "aaaaaaaaaaaaaaaa")
		rec := httptest.NewRecorder()
		f.h.Update(rec, withEmojiCtx(r, serverID, userID))
		return rec
	}

	rec := patch("srv", "admin", `{"name":"yeni_ad","display_name":"Yeni Ad"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("PATCH status = %d, body %s", rec.Code, rec.Body.String())
	}
	var got models.ServerEmoji
	decodeEnvelope(t, rec, &got)
	if got.Name != "yeni_ad" || got.DisplayName != "Yeni Ad" {
		t.Errorf("PATCH result = %+v", got)
	}
	if rec := patch("srv", "admin", `{"copyable":true}`); rec.Code != http.StatusForbidden || errorCode(t, rec) != "EXPRESSION_LICENSE_CREATOR_ONLY" {
		t.Errorf("non-creator copyable: status %d body %s", rec.Code, rec.Body.String())
	}
	if rec := patch("srv", "admin", `{}`); rec.Code != http.StatusBadRequest {
		t.Errorf("empty PATCH: status %d", rec.Code)
	}
	if rec := patch("other", "admin", `{"display_name":"X"}`); rec.Code != http.StatusNotFound {
		t.Errorf("cross-server PATCH: status %d, want 404", rec.Code)
	}

	del := func(serverID string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodDelete, "/api/servers/"+serverID+"/emojis/aaaaaaaaaaaaaaaa", nil)
		r.SetPathValue("emojiId", "aaaaaaaaaaaaaaaa")
		rec := httptest.NewRecorder()
		f.h.Delete(rec, withEmojiCtx(r, serverID, "admin"))
		return rec
	}
	if rec := del("other"); rec.Code != http.StatusNotFound {
		t.Errorf("cross-server DELETE: status %d, want 404", rec.Code)
	}
	if rec := del("srv"); rec.Code != http.StatusNoContent {
		t.Errorf("DELETE: status %d, want 204", rec.Code)
	}
	if f.repo.Len() != 0 {
		t.Error("row still present after DELETE")
	}
}

func TestEmojiHandler_ListMineAndList(t *testing.T) {
	f := newEmojiHandlerFixture(t, nil)
	f.repo.Put(models.ServerEmoji{ID: "aaaaaaaaaaaaaaaa", ServerID: "mine", Name: "kedi"})
	f.repo.Put(models.ServerEmoji{ID: "bbbbbbbbbbbbbbbb", ServerID: "theirs", Name: "kopek"})
	f.repo.ListForUserFn = func(_ context.Context, userID string) ([]models.ServerEmoji, error) {
		if userID != "alice" {
			return []models.ServerEmoji{}, nil
		}
		return f.repo.ListByServer(context.Background(), "mine")
	}

	rec := httptest.NewRecorder()
	f.h.ListMine(rec, withEmojiCtx(httptest.NewRequest(http.MethodGet, "/api/users/me/emojis", nil), "", "alice"))
	var mine []models.ServerEmoji
	decodeEnvelope(t, rec, &mine)
	if len(mine) != 1 || mine[0].ServerID != "mine" {
		t.Errorf("ListMine = %+v", mine)
	}

	rec = httptest.NewRecorder()
	f.h.List(rec, withEmojiCtx(httptest.NewRequest(http.MethodGet, "/api/servers/empty/emojis", nil), "empty", "alice"))
	if body := strings.TrimSpace(rec.Body.String()); !strings.Contains(body, `"data":[]`) {
		t.Errorf("empty list must be [] not null: %s", body)
	}
}
