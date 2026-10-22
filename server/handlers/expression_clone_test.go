// ExpressionCloneHandler over the REAL clone, emoji and sticker services,
// mock repos and a temp upload dir.
package handlers

import (
	"context"
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

type cloneHandlerFixture struct {
	dir         string
	emojiRepo   *testutil.MockEmojiRepo
	stickerRepo *testutil.MockStickerRepo
	h           *ExpressionCloneHandler
}

// newCloneHandlerFixture: "alice" is a member of every server, anyone else
// of none.
func newCloneHandlerFixture(t *testing.T, limiter *ratelimit.MessageRateLimiter) *cloneHandlerFixture {
	t.Helper()
	f := &cloneHandlerFixture{dir: t.TempDir(), emojiRepo: &testutil.MockEmojiRepo{}, stickerRepo: &testutil.MockStickerRepo{}}
	members := &testutil.MockServerRepo{IsMemberFn: func(_ context.Context, _, userID string) (bool, error) {
		return userID == "alice", nil
	}}
	hub := &testutil.MockBroadcaster{}
	emojiSvc := services.NewEmojiService(f.emojiRepo, members, hub, f.dir)
	stickerSvc := services.NewStickerService(f.stickerRepo, hub, f.dir)
	f.h = NewExpressionCloneHandler(services.NewExpressionCloneService(f.emojiRepo, emojiSvc, f.stickerRepo, stickerSvc, members, f.dir), limiter)
	return f
}

// putEmoji seeds emoji id in serverID with a real PNG file on disk.
func (f *cloneHandlerFixture) putEmoji(t *testing.T, id, serverID string, copyable bool) {
	t.Helper()
	dir := filepath.Join(f.dir, "emojis")
	if err := os.MkdirAll(dir, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, id+".png"), smallPNG(t), 0o600); err != nil {
		t.Fatal(err)
	}
	f.emojiRepo.Put(models.ServerEmoji{ID: id, ServerID: serverID, Name: "kedi", DisplayName: "Kedi",
		URL: "/api/uploads/emojis/" + id + ".png", Copyable: copyable})
}

func (f *cloneHandlerFixture) putSticker(t *testing.T, id, serverID string, copyable bool) {
	t.Helper()
	dir := filepath.Join(f.dir, "stickers")
	if err := os.MkdirAll(dir, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, id+".png"), smallPNG(t), 0o600); err != nil {
		t.Fatal(err)
	}
	f.stickerRepo.Put(models.ServerSticker{ID: id, ServerID: serverID, Name: "kedi", DisplayName: "Kedi",
		Tags: []string{"kedi"}, URL: "/api/uploads/stickers/" + id + ".png", Copyable: copyable})
}

func cloneRequest(kind, target, userID, body string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/api/servers/"+target+"/"+kind+"/clone", strings.NewReader(body))
	return withEmojiCtx(r, target, userID)
}

func TestCloneHandler_EmojiCreated(t *testing.T) {
	f := newCloneHandlerFixture(t, nil)
	f.putEmoji(t, "aaaaaaaaaaaaaaaa", "src", true)

	rec := httptest.NewRecorder()
	f.h.CloneEmoji(rec, cloneRequest("emojis", "dst", "alice", `{"source_id":"aaaaaaaaaaaaaaaa"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var got map[string]any
	decodeEnvelope(t, rec, &got)
	if got["cloned_from"] != "aaaaaaaaaaaaaaaa" || got["copyable"] != false || got["server_id"] != "dst" || got["created_by"] != "alice" {
		t.Errorf("clone = %v", got)
	}
}

func TestCloneHandler_StickerCreated(t *testing.T) {
	f := newCloneHandlerFixture(t, nil)
	f.putSticker(t, "aaaaaaaaaaaaaaaa", "src", true)

	rec := httptest.NewRecorder()
	f.h.CloneSticker(rec, cloneRequest("stickers", "dst", "alice", `{"source_id":"aaaaaaaaaaaaaaaa","name":"kedi_kopya"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var got models.ServerSticker
	decodeEnvelope(t, rec, &got)
	if got.Name != "kedi_kopya" || got.ClonedFrom == nil || *got.ClonedFrom != "aaaaaaaaaaaaaaaa" || got.Copyable {
		t.Errorf("clone = %+v", got)
	}
}

func TestCloneHandler_ErrorCodes(t *testing.T) {
	cases := []struct {
		name, kind, target, user, body string
		status                         int
		code                           string
	}{
		{"missing source", "emojis", "dst", "alice", `{"source_id":"ffffffffffffffff"}`, http.StatusNotFound, "EXPRESSION_NOT_FOUND"},
		{"not a member", "emojis", "dst", "mallory", `{"source_id":"aaaaaaaaaaaaaaaa"}`, http.StatusNotFound, "EXPRESSION_NOT_FOUND"},
		{"not copyable", "emojis", "dst", "alice", `{"source_id":"bbbbbbbbbbbbbbbb"}`, http.StatusForbidden, "EXPRESSION_NOT_COPYABLE"},
		{"same server", "emojis", "src", "alice", `{"source_id":"aaaaaaaaaaaaaaaa"}`, http.StatusBadRequest, "EXPRESSION_CLONE_SAME_SERVER"},
		{"invalid source id", "emojis", "dst", "alice", `{"source_id":"../../x"}`, http.StatusBadRequest, ""},
		{"bad name", "emojis", "dst", "alice", `{"source_id":"aaaaaaaaaaaaaaaa","name":"Bad Name"}`, http.StatusBadRequest, "EXPRESSION_NAME_INVALID"},
		{"name taken", "emojis", "taken", "alice", `{"source_id":"aaaaaaaaaaaaaaaa"}`, http.StatusConflict, "EXPRESSION_NAME_TAKEN"},
		{"bad body", "emojis", "dst", "alice", `not json`, http.StatusBadRequest, ""},
		{"oversized body", "emojis", "dst", "alice", `{"source_id":"aaaaaaaaaaaaaaaa","name":"` + strings.Repeat("a", 2000) + `"}`, http.StatusBadRequest, ""},
		{"sticker not copyable", "stickers", "dst", "alice", `{"source_id":"bbbbbbbbbbbbbbbb"}`, http.StatusForbidden, "EXPRESSION_NOT_COPYABLE"},
		{"sticker missing", "stickers", "dst", "mallory", `{"source_id":"aaaaaaaaaaaaaaaa"}`, http.StatusNotFound, "EXPRESSION_NOT_FOUND"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newCloneHandlerFixture(t, nil)
			f.putEmoji(t, "aaaaaaaaaaaaaaaa", "src", true)
			f.putEmoji(t, "bbbbbbbbbbbbbbbb", "src", false)
			f.emojiRepo.Put(models.ServerEmoji{ID: "cccccccccccccccc", ServerID: "taken", Name: "kedi"})
			f.putSticker(t, "aaaaaaaaaaaaaaaa", "src", true)
			f.putSticker(t, "bbbbbbbbbbbbbbbb", "src", false)

			rec := httptest.NewRecorder()
			req := cloneRequest(tc.kind, tc.target, tc.user, tc.body)
			if tc.kind == "emojis" {
				f.h.CloneEmoji(rec, req)
			} else {
				f.h.CloneSticker(rec, req)
			}
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

func TestCloneHandler_RateLimited(t *testing.T) {
	f := newCloneHandlerFixture(t, ratelimit.NewMessageRateLimiter(1, time.Minute, 30*time.Second))
	f.putEmoji(t, "aaaaaaaaaaaaaaaa", "src", true)
	first := httptest.NewRecorder()
	f.h.CloneEmoji(first, cloneRequest("emojis", "dst", "alice", `{"source_id":"aaaaaaaaaaaaaaaa"}`))
	if first.Code != http.StatusCreated {
		t.Fatalf("first clone status = %d, body %s", first.Code, first.Body.String())
	}
	second := httptest.NewRecorder()
	f.h.CloneEmoji(second, cloneRequest("emojis", "dst2", "alice", `{"source_id":"aaaaaaaaaaaaaaaa"}`))
	if second.Code != http.StatusTooManyRequests || second.Header().Get("Retry-After") == "" {
		t.Errorf("second clone status = %d, Retry-After %q", second.Code, second.Header().Get("Retry-After"))
	}
}
