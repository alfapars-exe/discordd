package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

type operationUpload struct {
	services.GroupDMUploadService
	calls     int
	failFirst bool
}

func (u *operationUpload) Upload(ctx context.Context, id string, f multipart.File, h *multipart.FileHeader, index int) (*models.GroupDMAttachment, error) {
	u.calls++
	if u.failFirst && index == 0 {
		return nil, errors.New("test upload interrupted")
	}
	return u.GroupDMUploadService.Upload(ctx, id, f, h, index)
}

func groupOperationFixture(t *testing.T) (*GroupDMHandler, repository.GroupDMRepository, *database.DB, *operationUpload, *int) {
	t.Helper()
	migrations, err := fs.Sub(database.EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatal(err)
	}
	db, err := database.New(filepath.Join(t.TempDir(), "operations.db"), migrations)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if _, err = db.Conn.Exec(`INSERT INTO users(id,username,password_hash) VALUES('op-sender','op-sender','x'),('op-reader','op-reader','x')`); err != nil {
		t.Fatal(err)
	}
	repo := repository.NewSQLiteGroupDMRepo(database.NewRetryingQuerier(db.Conn))
	if err = repo.Create(context.Background(), &models.GroupDM{ID: "group", OwnerID: "op-sender", Name: "Group", KeyEpoch: 1, CallRoomKey: "room"}, []string{"op-sender", "op-reader"}); err != nil {
		t.Fatal(err)
	}
	users := &testutil.MockUserRepo{GetByIDFn: func(_ context.Context, id string) (*models.User, error) {
		return &models.User{ID: id, Username: id}, nil
	}}
	broadcasts := new(int)
	hub := &testutil.MockBroadcaster{BroadcastToUsersFn: func([]string, ws.Event) { *broadcasts++ }}
	service := services.NewGroupDMService(repo, users, nil, hub, "", "", "", nil, t.TempDir())
	upload := &operationUpload{GroupDMUploadService: services.NewGroupDMUploadService(repo, t.TempDir(), 1024)}
	return NewGroupDMHandler(service, upload, 1024, nil, nil, nil), repo, db, upload, broadcasts
}

func operationRequest(method, key, body string, user string) *http.Request {
	r := httptest.NewRequest(method, "/api/group-dms/group/send-operations/"+key, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.SetPathValue("groupId", "group")
	r.SetPathValue("requestId", key)
	if user != "" {
		r = r.WithContext(context.WithValue(r.Context(), UserContextKey, &models.User{ID: user}))
	}
	return r
}
func operationPayload(key string) models.CreateGroupDMMessageRequest {
	cipher, device, meta := "cipher", "device", "{}"
	return models.CreateGroupDMMessageRequest{ClientRequestID: key, Ciphertext: &cipher, SenderDeviceID: &device, E2EEMetadata: &meta, KeyEpoch: 1}
}

func TestGroupDMSendOperationHTTPReplayAndAuthorization(t *testing.T) {
	h, repo, _, _, broadcasts := groupOperationFixture(t)
	ctx := context.Background()
	const key = "http-request-0001"
	payload := operationPayload(key)
	raw, _ := json.Marshal(payload)
	send := func() *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		h.SendMessage(w, operationRequest(http.MethodPost, key, string(raw), "op-sender"))
		return w
	}
	first := send()
	second := send()
	if first.Code != 201 || second.Code != 201 {
		t.Fatalf("first=%d %s second=%d %s", first.Code, first.Body.String(), second.Code, second.Body.String())
	}
	var result struct {
		Data models.GroupDMMessage `json:"data"`
	}
	if err := json.Unmarshal(first.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	var replay struct {
		Data models.GroupDMMessage `json:"data"`
	}
	_ = json.Unmarshal(second.Body.Bytes(), &replay)
	if result.Data.ID == "" || replay.Data.ID != result.Data.ID || *broadcasts != 1 {
		t.Fatalf("replay=%+v broadcasts=%d", replay, *broadcasts)
	}
	read, err := repo.GetReadState(ctx, "group", "op-reader")
	if err != nil || read.UnreadCount != 1 {
		t.Fatalf("read=%+v err=%v", read, err)
	}
	for _, user := range []string{"", "op-reader"} {
		w := httptest.NewRecorder()
		h.GetSendOutcome(w, operationRequest(http.MethodGet, key, "", user))
		want := 404
		if user == "" {
			want = 401
		}
		if w.Code != want {
			t.Fatalf("user=%q code=%d body=%s", user, w.Code, w.Body.String())
		}
	}
	// Replay must hydrate the current message, not resurrect a stored old response.
	edited := "edited cipher"
	device := "device"
	meta := "{}"
	if err = repo.UpdateMessage(ctx, "group", result.Data.ID, "op-sender", &models.UpdateGroupDMMessageRequest{Ciphertext: &edited, SenderDeviceID: &device, E2EEMetadata: &meta, KeyEpoch: 1}); err != nil {
		t.Fatal(err)
	}
	current := send()
	if current.Code != 201 || !strings.Contains(current.Body.String(), edited) {
		t.Fatal(current.Body.String())
	}
	if err = repo.DeleteMessage(ctx, "group", result.Data.ID, "op-sender"); err != nil {
		t.Fatal(err)
	}
	if deleted := send(); deleted.Code != 410 {
		t.Fatalf("deleted replay=%d %s", deleted.Code, deleted.Body.String())
	}
	if _, err = repo.RemoveMember(ctx, "group", "op-sender"); err != nil {
		t.Fatal(err)
	}
	denied := httptest.NewRecorder()
	h.GetSendOutcome(denied, operationRequest(http.MethodGet, key, "", "op-sender"))
	if denied.Code != 404 {
		t.Fatal(denied.Code, denied.Body.String())
	}
}

func TestGroupDMSendOperationHTTPMultipartHashAndPartialReplay(t *testing.T) {
	h, _, _, upload, _ := groupOperationFixture(t)
	upload.failFirst = true
	const key = "files-request-001"
	send := func(second string) *httptest.ResponseRecorder {
		var body bytes.Buffer
		writer := multipart.NewWriter(&body)
		for k, v := range map[string]string{"client_request_id": key, "ciphertext": "cipher", "sender_device_id": "device", "key_epoch": "1", "e2ee_metadata": "{}"} {
			if err := writer.WriteField(k, v); err != nil {
				t.Fatal(err)
			}
		}
		for i, data := range []string{"first", second} {
			part, err := writer.CreateFormFile("files", fmt.Sprintf("encrypted_%d.bin", i))
			if err != nil {
				t.Fatal(err)
			}
			if _, err = part.Write([]byte(data)); err != nil {
				t.Fatal(err)
			}
		}
		if err := writer.Close(); err != nil {
			t.Fatal(err)
		}
		r := operationRequest(http.MethodPost, key, "", "op-sender")
		r.Body = io.NopCloser(bytes.NewReader(body.Bytes()))
		r.ContentLength = int64(body.Len())
		r.Header.Set("Content-Type", writer.FormDataContentType())
		w := httptest.NewRecorder()
		h.SendMessage(w, r)
		return w
	}
	first, repeat := send("second"), send("second")
	if first.Code != 207 || repeat.Code != 207 || upload.calls != 2 {
		t.Fatalf("first=%d %s repeat=%d %s uploads=%d", first.Code, first.Body.String(), repeat.Code, repeat.Body.String(), upload.calls)
	}
	if !strings.Contains(repeat.Body.String(), `"file_key_index":0`) {
		t.Fatal(repeat.Body.String())
	}
	if changed := send("change"); changed.Code != 409 || upload.calls != 2 {
		t.Fatalf("changed=%d %s uploads=%d", changed.Code, changed.Body.String(), upload.calls)
	}
}

func TestGroupDMSendOperationHTTPPendingAndExplicitReconcile(t *testing.T) {
	h, repo, db, _, _ := groupOperationFixture(t)
	ctx := context.Background()
	const key = "pending-request-1"
	payload := operationPayload(key)
	hash, err := groupSendRequestHash(&payload, nil, 1024)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = repo.PrepareSend(ctx, "group", "op-sender", key, hash, 0); err != nil {
		t.Fatal(err)
	}
	if err = repo.CreateMessage(ctx, &models.GroupDMMessage{SendRequestID: key, GroupID: "group", UserID: "op-sender", KeyEpoch: 1, Ciphertext: payload.Ciphertext}); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(payload)
	w := httptest.NewRecorder()
	h.SendMessage(w, operationRequest(http.MethodPost, key, string(raw), "op-sender"))
	if w.Code != 202 {
		t.Fatal(w.Code, w.Body.String())
	}
	early := httptest.NewRecorder()
	h.ReconcileSend(early, operationRequest(http.MethodPost, key, "", "op-sender"))
	if early.Code != 202 {
		t.Fatal(early.Code, early.Body.String())
	}
	if _, err = db.Conn.Exec(`UPDATE group_dm_send_operations SET updated_at=? WHERE request_id=?`, "2000-01-01 00:00:00", key); err != nil {
		t.Fatal(err)
	}
	get := httptest.NewRecorder()
	h.GetSendOutcome(get, operationRequest(http.MethodGet, key, "", "op-sender"))
	if get.Code != 200 || !strings.Contains(get.Body.String(), `"phase":"committed"`) || strings.Contains(get.Body.String(), hash) {
		t.Fatal(get.Code, get.Body.String())
	}
	done := httptest.NewRecorder()
	h.ReconcileSend(done, operationRequest(http.MethodPost, key, "", "op-sender"))
	if done.Code != 201 {
		t.Fatal(done.Code, done.Body.String())
	}
	op, err := repo.GetSendOperation(ctx, "group", "op-sender", key)
	if err != nil || op.Phase != "completed" {
		t.Fatalf("op=%+v err=%v", op, err)
	}
}

func TestGroupDMSendOperationHTTPInterruptedFilesReconcile(t *testing.T) {
	h, repo, db, _, _ := groupOperationFixture(t)
	ctx := context.Background()
	const key = "interrupted-files-1"
	op, _, err := repo.PrepareSend(ctx, "group", "op-sender", key, strings.Repeat("a", 64), 2)
	if err != nil {
		t.Fatal(err)
	}
	if err = repo.CreateMessage(ctx, &models.GroupDMMessage{SendRequestID: key, GroupID: "group", UserID: "op-sender", KeyEpoch: 1}); err != nil {
		t.Fatal(err)
	}
	one := 1
	if err = repo.CreateAttachment(ctx, &models.GroupDMAttachment{GroupMessageID: op.MessageID, Filename: "encrypted_1.bin", FileURL: "/api/uploads/completed", FileKeyIndex: &one}); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Conn.Exec(`UPDATE group_dm_send_operations SET updated_at=? WHERE request_id=?`, "2000-01-01 00:00:00", key); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	h.ReconcileSend(w, operationRequest(http.MethodPost, key, "", "op-sender"))
	if w.Code != 207 || !strings.Contains(w.Body.String(), `"file_key_index":0`) {
		t.Fatal(w.Code, w.Body.String())
	}
	// Completion fences the original worker, even if it wakes up afterward.
	zero := 0
	if err = repo.CreateAttachment(ctx, &models.GroupDMAttachment{GroupMessageID: op.MessageID, Filename: "encrypted_0.bin", FileURL: "/api/uploads/late", FileKeyIndex: &zero}); !errors.Is(err, pkg.ErrConflict) {
		t.Fatal("late upload was not fenced", err)
	}
	again := httptest.NewRecorder()
	h.ReconcileSend(again, operationRequest(http.MethodPost, key, "", "op-sender"))
	if again.Code != 207 {
		t.Fatal(again.Code, again.Body.String())
	}
}

func TestGroupDMSendCancellationHTTP(t *testing.T) {
	h, repo, _, _, _ := groupOperationFixture(t)
	ctx := context.Background()
	const key = "cancel-http-00001"
	w := httptest.NewRecorder()
	h.CancelSend(w, operationRequest(http.MethodPost, key, "", "op-sender"))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"phase":"cancelled"`) {
		t.Fatal(w.Code, w.Body.String())
	}
	payload := operationPayload(key)
	raw, _ := json.Marshal(payload)
	late := httptest.NewRecorder()
	h.SendMessage(late, operationRequest(http.MethodPost, key, string(raw), "op-sender"))
	if late.Code != 409 {
		t.Fatal("late send not fenced", late.Code, late.Body.String())
	}
	const prepared = "prepared-cancel-01"
	payload = operationPayload(prepared)
	hash, _ := groupSendRequestHash(&payload, nil, 1024)
	if _, _, err := repo.PrepareSend(ctx, "group", "op-sender", prepared, hash, 0); err != nil {
		t.Fatal(err)
	}
	w = httptest.NewRecorder()
	h.CancelSend(w, operationRequest(http.MethodPost, prepared, "", "op-sender"))
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	raw, _ = json.Marshal(payload)
	late = httptest.NewRecorder()
	h.SendMessage(late, operationRequest(http.MethodPost, prepared, string(raw), "op-sender"))
	if late.Code != 410 || !strings.Contains(late.Body.String(), "SEND_CANCELLED") {
		t.Fatal(late.Code, late.Body.String())
	}
	const committed = "committed-cancel1"
	payload = operationPayload(committed)
	raw, _ = json.Marshal(payload)
	sent := httptest.NewRecorder()
	h.SendMessage(sent, operationRequest(http.MethodPost, committed, string(raw), "op-sender"))
	if sent.Code != 201 {
		t.Fatal(sent.Code, sent.Body.String())
	}
	w = httptest.NewRecorder()
	h.CancelSend(w, operationRequest(http.MethodPost, committed, "", "op-sender"))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"phase":"completed"`) {
		t.Fatal("committed message incorrectly cancelled", w.Code, w.Body.String())
	}
	// The same request key is scoped by sender. Another current member can
	// fence only their own absent request, never the sender's committed one.
	other := httptest.NewRecorder()
	h.CancelSend(other, operationRequest(http.MethodPost, committed, "", "op-reader"))
	if other.Code != 200 || !strings.Contains(other.Body.String(), `"phase":"cancelled"`) {
		t.Fatal(other.Code, other.Body.String())
	}
	original, err := repo.GetSendOperation(ctx, "group", "op-sender", committed)
	if err != nil || original.Phase != "completed" {
		t.Fatalf("other sender affected original: %+v %v", original, err)
	}
	denied := httptest.NewRecorder()
	h.CancelSend(denied, operationRequest(http.MethodPost, "unauthorized-001", "", ""))
	if denied.Code != 401 {
		t.Fatal(denied.Code)
	}
	if _, err := repo.RemoveMember(ctx, "group", "op-sender"); err != nil {
		t.Fatal(err)
	}
	denied = httptest.NewRecorder()
	h.CancelSend(denied, operationRequest(http.MethodPost, key, "", "op-sender"))
	if denied.Code != 404 {
		t.Fatal(denied.Code, denied.Body.String())
	}
}
