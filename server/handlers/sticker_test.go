// StickerHandler wired to the REAL services.StickerService over the
// in-memory testutil.MockStickerRepo. Shared helpers (emojiUpload,
// withEmojiCtx, errorCode, smallPNG, decodeEnvelope) come from
// emoji_test.go / avatar_test.go — redefining them is a compile error (#237).
package handlers

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg/ratelimit"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/testutil"
)

type stickerHandlerFixture struct {
	repo *testutil.MockStickerRepo
	dir  string
	h    *StickerHandler
}

func newStickerHandlerFixture(t *testing.T, limiter *ratelimit.MessageRateLimiter) *stickerHandlerFixture {
	t.Helper()
	f := &stickerHandlerFixture{repo: &testutil.MockStickerRepo{}, dir: t.TempDir()}
	svc := services.NewStickerService(f.repo, &testutil.MockBroadcaster{}, f.dir)
	f.h = NewStickerHandler(svc, limiter)
	return f
}

func TestStickerHandler_CreateShape(t *testing.T) {
	f := newStickerHandlerFixture(t, nil)
	rec := httptest.NewRecorder()
	f.h.Create(rec, emojiUpload(t, "srv", "alice", smallPNG(t), map[string]string{
		"display_name": "Mutlu Kedi",
		"description":  " mutlu bir kedi ",
		"tags":         "kedi, Kedi ,mutlu",
		"copyable":     "true",
	}))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var got map[string]any
	decodeEnvelope(t, rec, &got)
	for _, k := range []string{"id", "server_id", "name", "display_name", "description", "tags", "animated", "url",
		"animated_url", "copyable", "cloned_from", "created_by", "created_at"} {
		if _, ok := got[k]; !ok {
			t.Errorf("response missing %q: %v", k, got)
		}
	}
	id, _ := got["id"].(string)
	tags, _ := got["tags"].([]any)
	if got["name"] != "mutlu_kedi" || got["description"] != "mutlu bir kedi" || len(tags) != 2 ||
		tags[0] != "kedi" || tags[1] != "mutlu" || got["copyable"] != true || got["cloned_from"] != nil ||
		got["created_by"] != "alice" || got["url"] != "/api/uploads/stickers/"+id+".png" {
		t.Errorf("response = %v", got)
	}
	b, err := os.ReadFile(filepath.Join(f.dir, "stickers", id+".png"))
	if err != nil || !bytes.HasPrefix(b, pngMagic) {
		t.Errorf("stored file: err=%v", err)
	}
}

// TestStickerHandler_CreateIgnoresServerOwnedFields — the aklama pin: a form
// naming file_url / animated_url / created_by / cloned_from / id must not
// influence the row.
func TestStickerHandler_CreateIgnoresServerOwnedFields(t *testing.T) {
	f := newStickerHandlerFixture(t, nil)
	rec := httptest.NewRecorder()
	f.h.Create(rec, emojiUpload(t, "srv", "alice", smallPNG(t), map[string]string{
		"display_name": "Kedi",
		"file_url":     "/api/uploads/someone_elses_private.png",
		"animated_url": "/api/uploads/other.gif",
		"created_by":   "mallory",
		"cloned_from":  "ffffffffffffffff",
		"id":           "ffffffffffffffff",
		"server_id":    "victim",
	}))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var got models.ServerSticker
	decodeEnvelope(t, rec, &got)
	if got.ID == "ffffffffffffffff" || got.ServerID != "srv" || got.URL != "/api/uploads/stickers/"+got.ID+".png" ||
		got.AnimatedURL != nil || got.CreatedBy == nil || *got.CreatedBy != "alice" || got.ClonedFrom != nil {
		t.Errorf("client-supplied fields leaked into the row: %+v", got)
	}
}

func TestStickerHandler_CreateRejectsOversizedFile(t *testing.T) {
	f := newStickerHandlerFixture(t, nil)
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

func TestStickerHandler_CreateRateLimited(t *testing.T) {
	f := newStickerHandlerFixture(t, ratelimit.NewMessageRateLimiter(1, time.Minute, 30*time.Second))
	first := httptest.NewRecorder()
	f.h.Create(first, emojiUpload(t, "srv", "alice", smallPNG(t), map[string]string{"display_name": "Bir"}))
	if first.Code != http.StatusCreated {
		t.Fatalf("first upload status = %d, body %s", first.Code, first.Body.String())
	}
	second := httptest.NewRecorder()
	f.h.Create(second, emojiUpload(t, "srv", "alice", smallPNG(t), map[string]string{"display_name": "Iki"}))
	if second.Code != http.StatusTooManyRequests || second.Header().Get("Retry-After") == "" {
		t.Fatalf("second upload status = %d, Retry-After %q — want 429 with Retry-After", second.Code, second.Header().Get("Retry-After"))
	}
}

func TestStickerHandler_CreateErrorCodes(t *testing.T) {
	cases := []struct {
		name   string
		fields map[string]string
		file   []byte
		setup  func(f *stickerHandlerFixture)
		status int
		code   string
	}{
		{"bad name", map[string]string{"display_name": "Kedi", "name": "Bad Name"}, nil, nil, http.StatusBadRequest, "EXPRESSION_NAME_INVALID"},
		{"bad display name", map[string]string{"display_name": "evil‮"}, nil, nil, http.StatusBadRequest, "EXPRESSION_DISPLAY_NAME_INVALID"},
		{"bad description", map[string]string{"display_name": "Kedi", "description": "bir\niki"}, nil, nil, http.StatusBadRequest, "EXPRESSION_DESCRIPTION_INVALID"},
		{"too many tags", map[string]string{"display_name": "Kedi", "tags": "a,b,c,d,e,f"}, nil, nil, http.StatusBadRequest, "EXPRESSION_TAGS_INVALID"},
		{"name taken", map[string]string{"display_name": "Kedi"}, nil, func(f *stickerHandlerFixture) {
			f.repo.Put(models.ServerSticker{ID: "aaaaaaaaaaaaaaaa", ServerID: "srv", Name: "kedi"})
		}, http.StatusConflict, "EXPRESSION_NAME_TAKEN"},
		{"limit reached", map[string]string{"display_name": "Kedi"}, nil, func(f *stickerHandlerFixture) {
			for i := 0; i < models.MaxStickersPerServer; i++ {
				f.repo.Put(models.ServerSticker{ID: fmt.Sprintf("%016x", i), ServerID: "srv", Name: fmt.Sprintf("s_%02d", i)})
			}
		}, http.StatusBadRequest, "EXPRESSION_LIMIT_REACHED"},
		{"bad copyable", map[string]string{"display_name": "Kedi", "copyable": "yes"}, nil, nil, http.StatusBadRequest, ""},
		{"not an image", map[string]string{"display_name": "Kedi"}, append([]byte("BM"), make([]byte, 52)...), nil, http.StatusBadRequest, "BAD_REQUEST"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newStickerHandlerFixture(t, nil)
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
			if strings.Contains(rec.Body.String(), "emoji") {
				t.Errorf("sticker error uses emoji wording: %s", rec.Body.String())
			}
		})
	}
}

func TestWriteStickerImageError_AnimatedTooLargeWording(t *testing.T) {
	rec := httptest.NewRecorder()
	writeStickerImageError(rec, ErrAnimatedTooLarge)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), stickerAnimatedTooLargeMsg) {
		t.Errorf("status %d body %s", rec.Code, rec.Body.String())
	}
}

func TestStickerHandler_UpdateAndDelete(t *testing.T) {
	f := newStickerHandlerFixture(t, nil)
	creator, src := "alice", "cccccccccccccccc"
	f.repo.Put(models.ServerSticker{ID: "aaaaaaaaaaaaaaaa", ServerID: "srv", Name: "kedi", DisplayName: "Kedi", CreatedBy: &creator})
	f.repo.Put(models.ServerSticker{ID: "bbbbbbbbbbbbbbbb", ServerID: "srv", Name: "klon", DisplayName: "Klon", CreatedBy: &creator, ClonedFrom: &src})

	patch := func(serverID, id, userID, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPatch, "/api/servers/"+serverID+"/stickers/"+id, strings.NewReader(body))
		r.SetPathValue("stickerId", id)
		rec := httptest.NewRecorder()
		f.h.Update(rec, withEmojiCtx(r, serverID, userID))
		return rec
	}

	rec := patch("srv", "aaaaaaaaaaaaaaaa", "admin", `{"name":"yeni_ad","tags":["a"," A ","b"],"description":"x"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("PATCH status = %d, body %s", rec.Code, rec.Body.String())
	}
	var got models.ServerSticker
	decodeEnvelope(t, rec, &got)
	if got.Name != "yeni_ad" || !slices.Equal(got.Tags, []string{"a", "b"}) || got.Description != "x" {
		t.Errorf("PATCH result = %+v", got)
	}
	if rec := patch("srv", "aaaaaaaaaaaaaaaa", "admin", `{"copyable":true}`); rec.Code != http.StatusForbidden || errorCode(t, rec) != "EXPRESSION_LICENSE_CREATOR_ONLY" {
		t.Errorf("non-creator copyable: status %d body %s", rec.Code, rec.Body.String())
	}
	if rec := patch("srv", "bbbbbbbbbbbbbbbb", "alice", `{"copyable":true}`); rec.Code != http.StatusForbidden || errorCode(t, rec) != "EXPRESSION_LICENSE_LOCKED" {
		t.Errorf("clone copyable: status %d body %s", rec.Code, rec.Body.String())
	}
	if rec := patch("srv", "aaaaaaaaaaaaaaaa", "admin", `{"tags":["a,b"]}`); rec.Code != http.StatusBadRequest || errorCode(t, rec) != "EXPRESSION_TAGS_INVALID" {
		t.Errorf("bad tags: status %d body %s", rec.Code, rec.Body.String())
	}
	if rec := patch("srv", "aaaaaaaaaaaaaaaa", "admin", `{}`); rec.Code != http.StatusBadRequest {
		t.Errorf("empty PATCH: status %d", rec.Code)
	}
	if rec := patch("other", "aaaaaaaaaaaaaaaa", "admin", `{"display_name":"X"}`); rec.Code != http.StatusNotFound {
		t.Errorf("cross-server PATCH: status %d, want 404", rec.Code)
	}

	del := func(serverID string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodDelete, "/api/servers/"+serverID+"/stickers/aaaaaaaaaaaaaaaa", nil)
		r.SetPathValue("stickerId", "aaaaaaaaaaaaaaaa")
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
	if f.repo.Len() != 1 {
		t.Error("row still present after DELETE")
	}
}

func TestStickerHandler_ListMineAndList(t *testing.T) {
	f := newStickerHandlerFixture(t, nil)
	f.repo.Put(models.ServerSticker{ID: "aaaaaaaaaaaaaaaa", ServerID: "mine", Name: "kedi"})
	f.repo.Put(models.ServerSticker{ID: "bbbbbbbbbbbbbbbb", ServerID: "theirs", Name: "kopek"})
	f.repo.ListForUserFn = func(_ context.Context, userID string) ([]models.ServerSticker, error) {
		if userID != "alice" {
			return []models.ServerSticker{}, nil
		}
		return f.repo.ListByServer(context.Background(), "mine")
	}

	rec := httptest.NewRecorder()
	f.h.ListMine(rec, withEmojiCtx(httptest.NewRequest(http.MethodGet, "/api/users/me/stickers", nil), "", "alice"))
	var mine []models.ServerSticker
	decodeEnvelope(t, rec, &mine)
	if len(mine) != 1 || mine[0].ServerID != "mine" || mine[0].Tags == nil {
		t.Errorf("ListMine = %+v", mine)
	}

	rec = httptest.NewRecorder()
	f.h.List(rec, withEmojiCtx(httptest.NewRequest(http.MethodGet, "/api/servers/empty/stickers", nil), "empty", "alice"))
	if body := strings.TrimSpace(rec.Body.String()); !strings.Contains(body, `"data":[]`) {
		t.Errorf("empty list must be [] not null: %s", body)
	}
}
