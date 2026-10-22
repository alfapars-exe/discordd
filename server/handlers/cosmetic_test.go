// CosmeticHandler wired to the REAL services.CosmeticService over testutil
// mocks, so the status codes and COSMETIC_* codes the client contract pins
// are asserted end-to-end through the handler -> service path.
package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg/ratelimit"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/testutil"
)

func cosmeticTestItems() map[string]*models.CosmeticItem {
	s := func(v string) *string { return &v }
	return map[string]*models.CosmeticItem{
		"b_frame_aurora": {ID: "b_frame_aurora", Type: models.CosmeticTypeAvatarFrame, Format: models.CosmeticFormatSVG,
			Availability: "free", Animated: true, AssetJSON: s(`{"v":1,"frame":"aurora"}`)},
		"s1granted": {ID: "s1granted", ServerID: s("srv1"), Type: models.CosmeticTypeProfileEffect, Format: models.CosmeticFormatCSS,
			Availability: "granted", AssetJSON: s(`{"v":1,"effect":"snow","color":"#ffffff"}`)},
	}
}

func newCosmeticHandler(limiter *ratelimit.MessageRateLimiter) *CosmeticHandler {
	items := cosmeticTestItems()
	repo := &testutil.MockCosmeticRepo{
		GetItemFn: func(_ context.Context, id string) (*models.CosmeticItem, error) {
			if it, ok := items[id]; ok {
				cp := *it
				return &cp, nil
			}
			return nil, models.ErrCosmeticItemNotFound
		},
		ApplyEquipFn: func(context.Context, string, string, map[string]models.CosmeticEquipRow, []string) (bool, error) {
			return true, nil
		},
	}
	servers := &testutil.MockServerRepo{
		IsMemberFn: func(_ context.Context, serverID, _ string) (bool, error) { return serverID == "srv1", nil },
	}
	svc := services.NewCosmeticService(repo, servers, services.NewEveryoneCosmeticEntitlements(repo, servers), &testutil.MockBroadcaster{})
	return NewCosmeticHandler(svc, limiter)
}

func cosmeticRequest(method, target, body string) *http.Request {
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, target, nil)
	} else {
		r = httptest.NewRequest(method, target, strings.NewReader(body))
	}
	return withUser(r, &models.User{ID: "u1", Username: "u1"})
}

type cosmeticErrBody struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

func decodeCosmeticErr(t *testing.T, rec *httptest.ResponseRecorder) cosmeticErrBody {
	t.Helper()
	var b cosmeticErrBody
	if err := json.Unmarshal(rec.Body.Bytes(), &b); err != nil {
		t.Fatalf("decode error body: %v (%q)", err, rec.Body.String())
	}
	return b
}

func TestCosmeticHandler_GetMineShape(t *testing.T) {
	h := newCosmeticHandler(nil)
	rec := httptest.NewRecorder()
	h.GetMine(rec, cosmeticRequest(http.MethodGet, "/api/users/me/cosmetics", ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body.String())
	}
	var raw map[string]json.RawMessage
	decodeEnvelope(t, rec, &raw)
	want := map[string]string{
		"items":            `[]`,
		"grants":           `[]`,
		"equipped":         `{"global":{},"servers":{}}`,
		"plain_server_ids": `[]`,
	}
	for k, v := range want {
		if string(raw[k]) != v {
			t.Errorf("%s = %s, want %s", k, raw[k], v)
		}
	}
}

func TestCosmeticHandler_EquipStatusCodes(t *testing.T) {
	big := `{"scope":"global","slots":{"avatar_frame":"` + strings.Repeat("a", cosmeticMaxBody) + `"}}`
	cases := []struct {
		name   string
		body   string
		status int
		code   string
	}{
		{"ok", `{"scope":"global","slots":{"avatar_frame":"b_frame_aurora"}}`, http.StatusOK, ""},
		{"null unsets", `{"scope":"global","slots":{"avatar_frame":null}}`, http.StatusOK, ""},
		{"unknown slot key", `{"scope":"global","slots":{"halo":"b_frame_aurora"}}`, http.StatusBadRequest, "COSMETIC_SLOTS_INVALID"},
		{"empty slots", `{"scope":"global","slots":{}}`, http.StatusBadRequest, "COSMETIC_SLOTS_INVALID"},
		{"bad scope", `{"scope":"../x","slots":{"avatar_frame":null}}`, http.StatusBadRequest, "COSMETIC_SLOTS_INVALID"},
		{"slot mismatch", `{"scope":"global","slots":{"nameplate":"b_frame_aurora"}}`, http.StatusBadRequest, "COSMETIC_SLOT_MISMATCH"},
		{"scope mismatch", `{"scope":"global","slots":{"profile_effect":"s1granted"}}`, http.StatusBadRequest, "COSMETIC_SCOPE_MISMATCH"},
		{"not owned", `{"scope":"srv1","slots":{"profile_effect":"s1granted"}}`, http.StatusForbidden, "COSMETIC_NOT_OWNED"},
		{"missing item", `{"scope":"global","slots":{"avatar_frame":"nope"}}`, http.StatusNotFound, "NOT_FOUND"},
		{"non-member scope", `{"scope":"srv9","slots":{"avatar_frame":"b_frame_aurora"}}`, http.StatusNotFound, "NOT_FOUND"},
		{"unknown field", `{"scope":"global","slots":{"avatar_frame":null},"css":"x"}`, http.StatusBadRequest, "BAD_REQUEST"},
		{"not json", `nope`, http.StatusBadRequest, "BAD_REQUEST"},
		{"body over 4 KiB", big, http.StatusBadRequest, "BAD_REQUEST"},
	}
	messages := map[string]string{}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newCosmeticHandler(nil)
			rec := httptest.NewRecorder()
			h.Equip(rec, cosmeticRequest(http.MethodPut, "/api/users/me/cosmetics/equipped", tc.body))
			if rec.Code != tc.status {
				t.Fatalf("status = %d, want %d (%s)", rec.Code, tc.status, rec.Body.String())
			}
			if tc.code != "" {
				b := decodeCosmeticErr(t, rec)
				if b.Code != tc.code {
					t.Fatalf("code = %q, want %q", b.Code, tc.code)
				}
				messages[tc.name] = b.Error
			}
		})
	}
	if messages["missing item"] != messages["non-member scope"] {
		t.Fatalf("404 bodies differ: %q vs %q", messages["missing item"], messages["non-member scope"])
	}
}

func TestCosmeticHandler_BodyExactly4KiBPlusOneRejected(t *testing.T) {
	h := newCosmeticHandler(nil)
	prefix := `{"scope":"global","slots":{"avatar_frame":null}}`
	body := prefix + strings.Repeat(" ", cosmeticMaxBody+1-len(prefix))
	if len(body) != cosmeticMaxBody+1 {
		t.Fatalf("body len %d", len(body))
	}
	rec := httptest.NewRecorder()
	h.Equip(rec, cosmeticRequest(http.MethodPut, "/api/users/me/cosmetics/equipped", body))
	// A complete object padded past the cap is still rejected: the whole
	// body is read under MaxBytesReader before decoding.
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body.String())
	}
}

func TestCosmeticHandler_RateLimited(t *testing.T) {
	limiter := ratelimit.NewMessageRateLimiter(1, time.Minute, 30*time.Second)
	h := newCosmeticHandler(limiter)
	body := `{"scope":"global","slots":{"avatar_frame":"b_frame_aurora"}}`

	rec := httptest.NewRecorder()
	h.Equip(rec, cosmeticRequest(http.MethodPut, "/api/users/me/cosmetics/equipped", body))
	if rec.Code != http.StatusOK {
		t.Fatalf("first status = %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	h.Equip(rec, cosmeticRequest(http.MethodPut, "/api/users/me/cosmetics/equipped", body))
	if rec.Code != http.StatusTooManyRequests || rec.Header().Get("Retry-After") == "" {
		t.Fatalf("second status = %d, Retry-After = %q", rec.Code, rec.Header().Get("Retry-After"))
	}

	// The plain-server switch shares the budget.
	rec = httptest.NewRecorder()
	r := cosmeticRequest(http.MethodPut, "/api/users/me/cosmetics/plain-servers/srv1", `{"plain":true}`)
	r.SetPathValue("serverId", "srv1")
	h.SetPlainServer(rec, r)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("plain status = %d, want 429", rec.Code)
	}
}

func TestCosmeticHandler_SetPlainServer(t *testing.T) {
	cases := []struct {
		name     string
		serverID string
		body     string
		status   int
	}{
		{"member", "srv1", `{"plain":true}`, http.StatusNoContent},
		{"member off", "srv1", `{"plain":false}`, http.StatusNoContent},
		{"non-member", "srv9", `{"plain":true}`, http.StatusNotFound},
		{"missing plain", "srv1", `{}`, http.StatusBadRequest},
		{"wrong type", "srv1", `{"plain":"yes"}`, http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newCosmeticHandler(nil)
			rec := httptest.NewRecorder()
			r := cosmeticRequest(http.MethodPut, "/api/users/me/cosmetics/plain-servers/"+tc.serverID, tc.body)
			r.SetPathValue("serverId", tc.serverID)
			h.SetPlainServer(rec, r)
			if rec.Code != tc.status {
				t.Fatalf("status = %d, want %d (%s)", rec.Code, tc.status, rec.Body.String())
			}
		})
	}
}

func TestCosmeticHandler_LookupIDsBounds(t *testing.T) {
	ids101 := make([]string, 101)
	for i := range ids101 {
		ids101[i] = fmt.Sprintf("u%d", i)
	}
	ids100 := strings.Join(ids101[:100], ",")
	cases := []struct {
		name   string
		query  string
		status int
	}{
		{"missing", "", http.StatusBadRequest},
		{"empty", "?ids=", http.StatusBadRequest},
		{"empty entry", "?ids=a,,b", http.StatusBadRequest},
		{"malformed", "?ids=a,b%20c", http.StatusBadRequest},
		{"101 distinct", "?ids=" + strings.Join(ids101, ","), http.StatusBadRequest},
		{"100 distinct", "?ids=" + ids100, http.StatusOK},
		{"duplicates collapse", "?ids=" + ids100 + "," + ids100, http.StatusOK},
		{"two", "?ids=a,b", http.StatusOK},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newCosmeticHandler(nil)
			rec := httptest.NewRecorder()
			h.LookupGlobal(rec, cosmeticRequest(http.MethodGet, "/api/users/cosmetics"+tc.query, ""))
			if rec.Code != tc.status {
				t.Fatalf("status = %d, want %d (%s)", rec.Code, tc.status, rec.Body.String())
			}
			if tc.status == http.StatusBadRequest {
				if b := decodeCosmeticErr(t, rec); b.Code != "COSMETIC_IDS_INVALID" {
					t.Fatalf("code = %q", b.Code)
				}
				return
			}
			var res map[string]json.RawMessage
			decodeEnvelope(t, rec, &res)
			if string(res["users"]) != `{}` {
				t.Fatalf("users = %s, want {}", res["users"])
			}
		})
	}
}

func TestCosmeticHandler_ServerCosmeticsShape(t *testing.T) {
	h := newCosmeticHandler(nil)
	rec := httptest.NewRecorder()
	r := cosmeticRequest(http.MethodGet, "/api/servers/srv1/cosmetics", "")
	r = r.WithContext(context.WithValue(r.Context(), ServerIDContextKey, "srv1"))
	h.ServerCosmetics(rec, r)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", rec.Code, rec.Body.String())
	}
	var res map[string]json.RawMessage
	decodeEnvelope(t, rec, &res)
	if string(res["server_id"]) != `"srv1"` || string(res["users"]) != `{}` {
		t.Fatalf("body = %s", rec.Body.String())
	}
}
