// EntranceHandler wired to the REAL services.EntranceService over testutil
// mocks, so the status codes and ENTRANCE_* codes of the client contract are
// asserted end-to-end through the handler → service path.
package handlers

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg/ratelimit"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/testutil"
)

type entranceHandlerFixture struct {
	repo  *testutil.MockEntranceRepo
	roles map[string][]models.Role
	h     *EntranceHandler
}

func newEntranceHandlerFixture(t *testing.T, limiter *ratelimit.MessageRateLimiter) *entranceHandlerFixture {
	t.Helper()
	f := &entranceHandlerFixture{repo: &testutil.MockEntranceRepo{}, roles: map[string][]models.Role{}}
	members := &testutil.MockServerRepo{IsMemberFn: func(_ context.Context, serverID, userID string) (bool, error) {
		return serverID == "srv1" && userID != "stranger", nil
	}}
	roles := &testutil.MockRoleRepo{GetByUserIDAndServerFn: func(_ context.Context, userID, _ string) ([]models.Role, error) {
		return f.roles[userID], nil
	}}
	channels := &testutil.MockChannelRepo{GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
		return &models.Channel{ID: id, ServerID: "srv1", Type: models.ChannelTypeVoice}, nil
	}}
	svc := services.NewEntranceService(f.repo, members, roles, channels,
		&testutil.MockChannelPermResolver{}, &testutil.MockBroadcaster{}, &testutil.MockVoiceStateGetter{}, t.TempDir())
	f.h = NewEntranceHandler(svc, limiter)
	return f
}

// entranceTestWav is a canonical mono 24 kHz 16-bit PCM WAV of ms millis.
func entranceTestWav(ms int) []byte {
	dataLen := 48 * ms
	out := make([]byte, 44+dataLen)
	copy(out[0:4], "RIFF")
	binary.LittleEndian.PutUint32(out[4:8], uint32(36+dataLen))
	copy(out[8:16], "WAVEfmt ")
	binary.LittleEndian.PutUint32(out[16:20], 16)
	binary.LittleEndian.PutUint16(out[20:22], 1)
	binary.LittleEndian.PutUint16(out[22:24], 1)
	binary.LittleEndian.PutUint32(out[24:28], 24000)
	binary.LittleEndian.PutUint32(out[28:32], 48000)
	binary.LittleEndian.PutUint16(out[32:34], 2)
	binary.LittleEndian.PutUint16(out[34:36], 16)
	copy(out[36:40], "data")
	binary.LittleEndian.PutUint32(out[40:44], uint32(dataLen))
	for i := 44; i < len(out); i++ {
		out[i] = byte(i)
	}
	return out
}

func entranceUploadRequest(t *testing.T, userID, contentType string, file []byte, fields map[string]string) *http.Request {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	for k, v := range fields {
		if err := mw.WriteField(k, v); err != nil {
			t.Fatalf("write field: %v", err)
		}
	}
	hdr := textproto.MIMEHeader{}
	hdr.Set("Content-Disposition", `form-data; name="file"; filename="clip.wav"`)
	hdr.Set("Content-Type", contentType)
	part, err := mw.CreatePart(hdr)
	if err != nil {
		t.Fatalf("create part: %v", err)
	}
	if _, err := part.Write(file); err != nil {
		t.Fatalf("write file: %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close multipart: %v", err)
	}
	r := httptest.NewRequest(http.MethodPost, "/api/users/me/entrance-sounds", &body)
	r.Header.Set("Content-Type", mw.FormDataContentType())
	return withEmojiCtx(r, "", userID)
}

func entranceJSONRequest(method, target, userID, serverID, body string) *http.Request {
	r := httptest.NewRequest(method, target, strings.NewReader(body))
	ctx := context.WithValue(r.Context(), UserContextKey, &models.User{ID: userID, Username: userID})
	if serverID != "" {
		ctx = context.WithValue(ctx, ServerIDContextKey, serverID)
	}
	return r.WithContext(ctx)
}

var entranceURLRe = regexp.MustCompile(`^/api/uploads/entrance/[a-f0-9]{16}\.wav$`)

func TestEntranceHandler_Upload_201IgnoresClientDuration(t *testing.T) {
	f := newEntranceHandlerFixture(t, nil)
	rec := httptest.NewRecorder()
	// duration_ms / file_url / user_id in the form are laundering attempts:
	// they must be ignored — the stored duration is the measured one.
	f.h.Upload(rec, entranceUploadRequest(t, "alice", "audio/wav", entranceTestWav(1500), map[string]string{
		"name": "Davul", "duration_ms": "99999", "file_url": "/api/uploads/avatar.png", "user_id": "bob",
	}))
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var env struct {
		Data models.EntranceSound `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode: %v", err)
	}
	s := env.Data
	if s.DurationMs != 1500 || s.Name != "Davul" || !entranceURLRe.MatchString(s.URL) || s.Size != int64(44+48*1500) || s.ID == "" {
		t.Errorf("sound = %+v", s)
	}
	if mine, _ := f.repo.ListSounds(context.Background(), "alice"); len(mine) != 1 {
		t.Errorf("alice's clips = %d, want 1 (stored for the caller, not the form's user_id)", len(mine))
	}
}

func TestEntranceHandler_Upload_Rejections(t *testing.T) {
	f := newEntranceHandlerFixture(t, nil)

	big := entranceTestWav(1000)
	big = append(big, make([]byte, models.EntranceMaxUploadBytes)...)
	rec := httptest.NewRecorder()
	f.h.Upload(rec, entranceUploadRequest(t, "alice", "audio/wav", big, map[string]string{"name": "x"}))
	if rec.Code != http.StatusBadRequest || errorCode(t, rec) != "ENTRANCE_FILE_TOO_LARGE" {
		t.Errorf(">1 MiB: status %d code %q", rec.Code, errorCode(t, rec))
	}

	mp3 := append([]byte("ID3\x03\x00\x00\x00\x00\x00\x00"), bytes.Repeat([]byte{0xFF, 0xFB, 0x90, 0x64}, 300)...)
	rec = httptest.NewRecorder()
	f.h.Upload(rec, entranceUploadRequest(t, "alice", "audio/mpeg", mp3, map[string]string{"name": "x"}))
	if rec.Code != http.StatusBadRequest || errorCode(t, rec) != "ENTRANCE_INVALID_AUDIO" {
		t.Errorf("mp3: status %d code %q", rec.Code, errorCode(t, rec))
	}

	rec = httptest.NewRecorder()
	f.h.Upload(rec, entranceUploadRequest(t, "alice", "audio/wav", entranceTestWav(50), map[string]string{"name": "x"}))
	if rec.Code != http.StatusBadRequest || errorCode(t, rec) != "ENTRANCE_DURATION_INVALID" {
		t.Errorf("50 ms: status %d code %q", rec.Code, errorCode(t, rec))
	}

	rec = httptest.NewRecorder()
	f.h.Upload(rec, entranceUploadRequest(t, "alice", "audio/wav", entranceTestWav(500), map[string]string{"name": ""}))
	if rec.Code != http.StatusBadRequest || errorCode(t, rec) != "ENTRANCE_NAME_INVALID" {
		t.Errorf("empty name: status %d code %q", rec.Code, errorCode(t, rec))
	}
}

func TestEntranceHandler_Upload_RateLimited(t *testing.T) {
	f := newEntranceHandlerFixture(t, ratelimit.NewMessageRateLimiter(1, time.Minute, 30*time.Second))
	first := httptest.NewRecorder()
	f.h.Upload(first, entranceUploadRequest(t, "alice", "audio/wav", entranceTestWav(300), map[string]string{"name": "a"}))
	if first.Code != http.StatusCreated {
		t.Fatalf("first upload: %d %s", first.Code, first.Body.String())
	}
	second := httptest.NewRecorder()
	f.h.Upload(second, entranceUploadRequest(t, "alice", "audio/wav", entranceTestWav(300), map[string]string{"name": "b"}))
	if second.Code != http.StatusTooManyRequests {
		t.Fatalf("second upload: status %d, want 429", second.Code)
	}
	if second.Header().Get("Retry-After") == "" {
		t.Error("429 without Retry-After")
	}
}

func TestEntranceHandler_PutSelection(t *testing.T) {
	f := newEntranceHandlerFixture(t, nil)
	rec := httptest.NewRecorder()
	f.h.PutSelection(rec, entranceJSONRequest(http.MethodPut, "/api/users/me/entrance-selection", "alice", "",
		`{"scope":"global","kind":"preset","preset":{"v":1,"theme":"bell","waveform":"sine","pitch":-2,"duration_ms":600}}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body.String())
	}
	var env struct {
		Data []models.EntranceSelection `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(env.Data) != 1 || env.Data[0].Scope != "global" || env.Data[0].Kind != "preset" ||
		env.Data[0].Preset == nil || env.Data[0].Preset.Pitch != -2 || env.Data[0].SoundID != nil {
		t.Errorf("selections = %+v", env.Data)
	}

	for name, c := range map[string]struct {
		user, body, code string
		status           int
	}{
		"bad kind":       {"alice", `{"scope":"global","kind":"loud"}`, "ENTRANCE_SCOPE_INVALID", 400},
		"bad preset":     {"alice", `{"scope":"global","kind":"preset","preset":{"v":1,"theme":"bell","waveform":"sine","pitch":0,"duration_ms":800,"gain":9}}`, "ENTRANCE_PRESET_INVALID", 400},
		"foreign server": {"stranger", `{"scope":"srv1","kind":"none"}`, "NOT_FOUND", 404},
		"foreign clip":   {"alice", `{"scope":"global","kind":"clip","sound_id":"0123456789abcdef"}`, "NOT_FOUND", 404},
	} {
		rec := httptest.NewRecorder()
		f.h.PutSelection(rec, entranceJSONRequest(http.MethodPut, "/api/users/me/entrance-selection", c.user, "", c.body))
		if rec.Code != c.status || errorCode(t, rec) != c.code {
			t.Errorf("%s: status %d code %q, want %d %q", name, rec.Code, errorCode(t, rec), c.status, c.code)
		}
	}
}

func TestEntranceHandler_RenameAndDeleteForeignClip404(t *testing.T) {
	f := newEntranceHandlerFixture(t, nil)
	f.repo.PutSound(models.EntranceSound{ID: "0123456789abcdef", UserID: "bob", Name: "b", URL: "/api/uploads/entrance/0123456789abcdef.wav"})

	rec := httptest.NewRecorder()
	r := entranceJSONRequest(http.MethodPatch, "/api/users/me/entrance-sounds/0123456789abcdef", "alice", "", `{"name":"mine"}`)
	r.SetPathValue("soundId", "0123456789abcdef")
	f.h.Rename(rec, r)
	if rec.Code != http.StatusNotFound {
		t.Errorf("foreign rename: status %d, want 404", rec.Code)
	}
	rec = httptest.NewRecorder()
	r = entranceJSONRequest(http.MethodDelete, "/api/users/me/entrance-sounds/0123456789abcdef", "alice", "", "")
	r.SetPathValue("soundId", "0123456789abcdef")
	f.h.Delete(rec, r)
	if rec.Code != http.StatusNotFound {
		t.Errorf("foreign delete: status %d, want 404", rec.Code)
	}
	rec = httptest.NewRecorder()
	r = entranceJSONRequest(http.MethodPatch, "/api/users/me/entrance-sounds/0123456789abcdef", "bob", "", `{"name":"Zil"}`)
	r.SetPathValue("soundId", "0123456789abcdef")
	f.h.Rename(rec, r)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"name":"Zil"`) {
		t.Errorf("own rename: status %d body %s", rec.Code, rec.Body.String())
	}
}

func TestEntranceHandler_PatchSettingsBounds(t *testing.T) {
	f := newEntranceHandlerFixture(t, nil)
	for body, want := range map[string]int{
		`{"max_duration_ms":499}`:  400,
		`{"max_duration_ms":5001}`: 400,
		`{}`:                       400,
		`{"max_duration_ms":1000}`: 200,
		`{"enabled":false}`:        200,
	} {
		rec := httptest.NewRecorder()
		f.h.PatchSettings(rec, entranceJSONRequest(http.MethodPatch, "/api/servers/srv1/entrance-settings", "alice", "srv1", body))
		if rec.Code != want {
			t.Errorf("%s: status %d, want %d", body, rec.Code, want)
		}
		if want == 400 && errorCode(t, rec) != "ENTRANCE_SETTINGS_INVALID" {
			t.Errorf("%s: code %q", body, errorCode(t, rec))
		}
	}
	rec := httptest.NewRecorder()
	f.h.GetSettings(rec, entranceJSONRequest(http.MethodGet, "/api/servers/srv1/entrance-settings", "alice", "srv1", ""))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"max_duration_ms":1000`) ||
		!strings.Contains(rec.Body.String(), `"enabled":false`) || !strings.Contains(rec.Body.String(), `"disabled_channel_ids":[]`) {
		t.Errorf("get settings: %d %s", rec.Code, rec.Body.String())
	}
}

func TestEntranceHandler_Mutes(t *testing.T) {
	f := newEntranceHandlerFixture(t, nil)
	f.roles["mod"] = []models.Role{{Position: 5}}
	f.roles["bob"] = []models.Role{{Position: 1}}
	f.roles["peer"] = []models.Role{{Position: 5}}

	mute := func(method, target string) int {
		rec := httptest.NewRecorder()
		r := entranceJSONRequest(method, "/api/servers/srv1/entrance-mutes/"+target, "mod", "srv1", "")
		r.SetPathValue("userId", target)
		if method == http.MethodPut {
			f.h.Mute(rec, r)
		} else {
			f.h.Unmute(rec, r)
		}
		return rec.Code
	}
	if got := mute(http.MethodPut, "bob"); got != http.StatusNoContent {
		t.Errorf("mute bob: %d, want 204", got)
	}
	if got := mute(http.MethodPut, "peer"); got != http.StatusForbidden {
		t.Errorf("mute equal rank: %d, want 403", got)
	}
	if got := mute(http.MethodPut, "stranger"); got != http.StatusNotFound {
		t.Errorf("mute non-member: %d, want 404", got)
	}
	rec := httptest.NewRecorder()
	f.h.ListMutes(rec, entranceJSONRequest(http.MethodGet, "/api/servers/srv1/entrance-mutes", "mod", "srv1", ""))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"user_ids":["bob"]`) {
		t.Errorf("list mutes: %d %s", rec.Code, rec.Body.String())
	}
	if got := mute(http.MethodDelete, "bob"); got != http.StatusNoContent {
		t.Errorf("unmute bob: %d, want 204", got)
	}
}

func TestEntranceHandler_SetChannelRequiresEnabled(t *testing.T) {
	f := newEntranceHandlerFixture(t, nil)
	rec := httptest.NewRecorder()
	r := entranceJSONRequest(http.MethodPut, "/api/servers/srv1/channels/v1/entrance", "mod", "srv1", `{}`)
	r.SetPathValue("channelId", "v1")
	f.h.SetChannel(rec, r)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("missing enabled: %d, want 400", rec.Code)
	}
	rec = httptest.NewRecorder()
	r = entranceJSONRequest(http.MethodPut, "/api/servers/srv1/channels/v1/entrance", "mod", "srv1", `{"enabled":false}`)
	r.SetPathValue("channelId", "v1")
	f.h.SetChannel(rec, r)
	if rec.Code != http.StatusNoContent {
		t.Errorf("disable: %d, want 204", rec.Code)
	}
}
