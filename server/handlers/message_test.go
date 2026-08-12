// MessageHandler.Create multipart tests, focused on the partial-failure
// contract.
//
// Attachment upload failures used to be swallowed by a bare `continue`: the
// message landed without its files and the sender had no idea anything went
// wrong. Create now collects per-file failures and, when there is at least
// one, answers 207 Multi-Status with BOTH the created message and a
// upload_failures list, so the client can render the message with per-file
// error chips and offer a retry.
//
// That envelope is a client contract — client/src reads data.message and
// data.upload_failures[].{filename,error} to drive the rejection toast — so
// its shape is pinned here rather than left to whoever next edits the handler.
package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
)

// ─── stubs ───

// stubMessageService returns a fixed created message and records broadcasts.
// Only Create/BroadcastCreate are exercised; the rest satisfy the interface.
// Create fans the broadcast out on its own goroutine (logx.Go in
// handlers/message.go), so `broadcasts` is written from that goroutine and read
// from the test goroutine. Both halves need the mutex, and a positive assertion
// additionally has to WAIT for the append rather than sampling whenever the
// handler happens to return — without that the test either reads zero or, under
// -race, reports the write/read pair as a data race (it did: CI runs
// `go test -race`, a plain `go test` never saw it).
type stubMessageService struct {
	createFn func(ctx context.Context, serverID, channelID, userID string, req *models.CreateMessageRequest) (*models.Message, error)

	mu         sync.Mutex
	broadcasts []*models.Message
}

// broadcastCount reports how many broadcasts have landed so far.
func (s *stubMessageService) broadcastCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.broadcasts)
}

// waitForBroadcasts blocks until n broadcasts have landed, or fails the test.
// Use for POSITIVE assertions ("it does broadcast").
func (s *stubMessageService) waitForBroadcasts(t *testing.T, n int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if s.broadcastCount() >= n {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Errorf("BroadcastCreate called %d times, want %d", s.broadcastCount(), n)
}

// assertNoBroadcast gives the goroutine a window to misbehave in, then asserts
// it never did. Use for NEGATIVE assertions ("it must not broadcast") — reading
// immediately would pass even if the broadcast were merely late.
func (s *stubMessageService) assertNoBroadcast(t *testing.T) {
	t.Helper()
	time.Sleep(150 * time.Millisecond)
	if n := s.broadcastCount(); n != 0 {
		t.Errorf("broadcast sent %d time(s) for a message that was never created", n)
	}
}

func (s *stubMessageService) GetByChannelID(_ context.Context, _, _, _ string, _ string, _ int) (*models.MessagePage, error) {
	return nil, nil
}

func (s *stubMessageService) Create(ctx context.Context, serverID, channelID, userID string, req *models.CreateMessageRequest) (*models.Message, error) {
	if s.createFn != nil {
		return s.createFn(ctx, serverID, channelID, userID, req)
	}
	content := req.Content
	return &models.Message{ID: "msg-1", ChannelID: channelID, UserID: userID, Content: &content}, nil
}

func (s *stubMessageService) BroadcastCreate(message *models.Message) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.broadcasts = append(s.broadcasts, message)
}

func (s *stubMessageService) Update(_ context.Context, _, _, _ string, _ *models.UpdateMessageRequest) (*models.Message, error) {
	return nil, nil
}
func (s *stubMessageService) Delete(_ context.Context, _, _, _ string, _ models.Permission) error {
	return nil
}
func (s *stubMessageService) SetAuditLogger(_ services.AuditWriter) {}
func (s *stubMessageService) SetUploadDir(_ string)                 {}

// stubUploadService succeeds or fails per filename, so a single multipart
// request can carry one good file and one bad one.
type stubUploadService struct {
	failFor map[string]error
	seen    []string
}

func (s *stubUploadService) Upload(_ context.Context, messageID string, _ multipart.File, header *multipart.FileHeader, _ bool) (*models.Attachment, error) {
	s.seen = append(s.seen, header.Filename)
	if err, bad := s.failFor[header.Filename]; bad {
		return nil, err
	}
	return &models.Attachment{
		ID:        "att-" + header.Filename,
		MessageID: messageID,
		Filename:  header.Filename,
		FileURL:   "/api/uploads/stored-" + header.Filename,
	}, nil
}

var (
	_ services.MessageService = (*stubMessageService)(nil)
	_ services.UploadService  = (*stubUploadService)(nil)
)

// ─── request builders ───

// multipartBody builds a message-create form with the given content and files.
func multipartBody(t *testing.T, content string, files map[string]string, extra map[string]string) (*bytes.Buffer, string) {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)

	if err := w.WriteField("content", content); err != nil {
		t.Fatalf("write content field: %v", err)
	}
	for k, v := range extra {
		if err := w.WriteField(k, v); err != nil {
			t.Fatalf("write field %s: %v", k, err)
		}
	}
	// Deterministic order — the response's upload_failures order follows the
	// order the parts appear in the body.
	for _, name := range sortedKeys(files) {
		part, err := w.CreateFormFile("files", name)
		if err != nil {
			t.Fatalf("create form file %s: %v", name, err)
		}
		if _, err := part.Write([]byte(files[name])); err != nil {
			t.Fatalf("write form file %s: %v", name, err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}
	return &buf, w.FormDataContentType()
}

func sortedKeys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	// Small n; insertion sort keeps this dependency-free and stable.
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j] < out[j-1]; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// newCreateRequest builds a POST with the server-id and user context the
// handler reads out of the request context (normally set by middleware).
func newCreateRequest(t *testing.T, body *bytes.Buffer, contentType string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/channels/chan-1/messages", body)
	req.Header.Set("Content-Type", contentType)
	req.SetPathValue("id", "chan-1")
	ctx := context.WithValue(req.Context(), ServerIDContextKey, "server-1")
	ctx = context.WithValue(ctx, UserContextKey, &models.User{ID: "user-1", Username: "sender"})
	return req.WithContext(ctx)
}

// uploadFailure mirrors the anonymous struct the handler serialises.
type uploadFailure struct {
	Filename string `json:"filename"`
	Error    string `json:"error"`
}

// multiStatusBody is the 207 payload the client parses.
type multiStatusBody struct {
	Message        *models.Message `json:"message"`
	UploadFailures []uploadFailure `json:"upload_failures"`
}

// ─── tests ───

// TestMessageCreate_PartialUploadFailureReturns207 is the headline case: two
// attachments, one of which the upload service rejects. The message itself was
// created, so the response is 207 (not 500, not 201) and carries both halves.
func TestMessageCreate_PartialUploadFailureReturns207(t *testing.T) {
	const badFile = "a-rejected.exe"
	const goodFile = "b-accepted.png"
	const uploadErrMsg = "file type not allowed"

	msgSvc := &stubMessageService{}
	upSvc := &stubUploadService{
		// Wrapped in ErrBadRequest to mirror the real UploadService, whose
		// client-facing validation errors all use the "%w: …" convention
		// (upload_service.go). Unwrapped errors are infrastructure failures
		// and collapse to the generic "upload failed" (CWE-209).
		failFor: map[string]error{badFile: fmt.Errorf("%w: %s", pkg.ErrBadRequest, uploadErrMsg)},
	}
	h := NewMessageHandler(msgSvc, upSvc, 1<<20, nil, nil)

	body, ct := multipartBody(t, "iki dosya", map[string]string{
		badFile:  "MZ-fake-exe",
		goodFile: "png-bytes",
	}, nil)

	rec := httptest.NewRecorder()
	h.Create(rec, newCreateRequest(t, body, ct))

	if rec.Code != http.StatusMultiStatus {
		t.Fatalf("status = %d, want 207 (body %s)", rec.Code, rec.Body.String())
	}

	// Outer envelope is still the standard pkg.APIResponse with success=true —
	// the message WAS created, the partial failure lives in the data payload.
	var env struct {
		Success bool            `json:"success"`
		Error   string          `json:"error"`
		Data    multiStatusBody `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("unmarshal 207 body: %v (raw %s)", err, rec.Body.String())
	}
	if !env.Success {
		t.Errorf("envelope success = false, want true (the message was created)")
	}
	if env.Error != "" {
		t.Errorf("envelope error = %q, want empty", env.Error)
	}

	if env.Data.Message == nil {
		t.Fatalf("data.message is missing — the client needs it to render the sent message")
	}
	if env.Data.Message.ID != "msg-1" {
		t.Errorf("data.message.id = %q, want msg-1", env.Data.Message.ID)
	}
	// server_id is set transiently before broadcast so clients can route
	// cross-server notifications; it must survive into the 207 body too.
	if env.Data.Message.ServerID != "server-1" {
		t.Errorf("data.message.server_id = %q, want server-1", env.Data.Message.ServerID)
	}

	// The succeeding attachment is attached to the message...
	if len(env.Data.Message.Attachments) != 1 {
		t.Fatalf("data.message.attachments = %d, want 1 (only the accepted file)", len(env.Data.Message.Attachments))
	}
	if got := env.Data.Message.Attachments[0].Filename; got != goodFile {
		t.Errorf("attached file = %q, want %q", got, goodFile)
	}

	// ...and only the failing one is reported.
	if len(env.Data.UploadFailures) != 1 {
		t.Fatalf("data.upload_failures = %d, want 1 (raw %s)", len(env.Data.UploadFailures), rec.Body.String())
	}
	f := env.Data.UploadFailures[0]
	if f.Filename != badFile {
		t.Errorf("upload_failures[0].filename = %q, want %q", f.Filename, badFile)
	}
	wantErr := pkg.ErrBadRequest.Error() + ": " + uploadErrMsg
	if f.Error != wantErr {
		t.Errorf("upload_failures[0].error = %q, want %q", f.Error, wantErr)
	}

	// Both files were attempted — a failure must not abort the remaining ones.
	if len(upSvc.seen) != 2 {
		t.Errorf("upload attempted for %v, want both files", upSvc.seen)
	}

	// The message is broadcast regardless: recipients see it with whatever
	// attachments made it, and the sender learns about the failures from the
	// 207 body.
	msgSvc.waitForBroadcasts(t, 1)
}

// TestMessageCreate_MultipartStatusMatrix walks the three outcomes so the 207
// isn't defined only by its own happy case: all-good is 201, all-bad is still
// 207 (the message exists), and a text-only multipart send is 201.
func TestMessageCreate_MultipartStatusMatrix(t *testing.T) {
	cases := []struct {
		name         string
		files        map[string]string
		failFor      map[string]error
		wantStatus   int
		wantFailures int
		wantAttached int
	}{
		{
			name:         "all uploads succeed",
			files:        map[string]string{"a.png": "1", "b.png": "2"},
			wantStatus:   http.StatusCreated,
			wantFailures: 0,
			wantAttached: 2,
		},
		{
			name:         "one of two fails",
			files:        map[string]string{"a.png": "1", "b.png": "2"},
			failFor:      map[string]error{"b.png": fmt.Errorf("disk full")},
			wantStatus:   http.StatusMultiStatus,
			wantFailures: 1,
			wantAttached: 1,
		},
		{
			name:  "every upload fails",
			files: map[string]string{"a.png": "1", "b.png": "2"},
			failFor: map[string]error{
				"a.png": fmt.Errorf("disk full"),
				"b.png": fmt.Errorf("disk full"),
			},
			wantStatus:   http.StatusMultiStatus,
			wantFailures: 2,
			wantAttached: 0,
		},
		{
			name:         "multipart with no files at all",
			files:        nil,
			wantStatus:   http.StatusCreated,
			wantFailures: 0,
			wantAttached: 0,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			upSvc := &stubUploadService{failFor: tc.failFor}
			h := NewMessageHandler(&stubMessageService{}, upSvc, 1<<20, nil, nil)

			body, ct := multipartBody(t, "merhaba", tc.files, nil)
			rec := httptest.NewRecorder()
			h.Create(rec, newCreateRequest(t, body, ct))

			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, tc.wantStatus, rec.Body.String())
			}

			raw := rec.Body.Bytes()
			if tc.wantStatus == http.StatusMultiStatus {
				var env struct {
					Data multiStatusBody `json:"data"`
				}
				if err := json.Unmarshal(raw, &env); err != nil {
					t.Fatalf("unmarshal: %v", err)
				}
				if len(env.Data.UploadFailures) != tc.wantFailures {
					t.Errorf("upload_failures = %d, want %d", len(env.Data.UploadFailures), tc.wantFailures)
				}
				if env.Data.Message == nil {
					t.Fatalf("207 without data.message")
				}
				if len(env.Data.Message.Attachments) != tc.wantAttached {
					t.Errorf("attachments = %d, want %d", len(env.Data.Message.Attachments), tc.wantAttached)
				}
				for _, f := range env.Data.UploadFailures {
					if f.Filename == "" || f.Error == "" {
						t.Errorf("upload_failures entry is missing a field: %+v", f)
					}
				}
				return
			}

			// 201 path: the plain message envelope, no upload_failures key
			// anywhere (the client branches on its presence).
			if strings.Contains(string(raw), "upload_failures") {
				t.Errorf("201 response mentions upload_failures: %s", raw)
			}
			var env struct {
				Data models.Message `json:"data"`
			}
			if err := json.Unmarshal(raw, &env); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if len(env.Data.Attachments) != tc.wantAttached {
				t.Errorf("attachments = %d, want %d", len(env.Data.Attachments), tc.wantAttached)
			}
		})
	}
}

// TestMessageCreate_ServiceFailureIsNot207 draws the line the 207 depends on:
// if the MESSAGE itself couldn't be created there is nothing partial about the
// outcome, so uploads are never attempted and the response is a plain error.
func TestMessageCreate_ServiceFailureIsNot207(t *testing.T) {
	upSvc := &stubUploadService{}
	msgSvc := &stubMessageService{
		createFn: func(_ context.Context, _, _, _ string, _ *models.CreateMessageRequest) (*models.Message, error) {
			return nil, fmt.Errorf("%w: you cannot send messages here", pkg.ErrForbidden)
		},
	}
	h := NewMessageHandler(msgSvc, upSvc, 1<<20, nil, nil)

	body, ct := multipartBody(t, "nope", map[string]string{"a.png": "1"}, nil)
	rec := httptest.NewRecorder()
	h.Create(rec, newCreateRequest(t, body, ct))

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (body %s)", rec.Code, rec.Body.String())
	}
	if len(upSvc.seen) != 0 {
		t.Errorf("uploads attempted after message creation failed: %v", upSvc.seen)
	}
	msgSvc.assertNoBroadcast(t)
}

// TestMessageCreate_E2EEFieldConsistency pins the two multipart-only
// validations that guard the E2EE routing fields against a half-populated
// payload — the failure they prevent (a permanently undecryptable blob in
// everyone's history) only shows up on the recipients' devices.
func TestMessageCreate_E2EEFieldConsistency(t *testing.T) {
	cases := []struct {
		name       string
		extra      map[string]string
		wantStatus int
		wantError  string
	}{
		{
			name:       "encryption_version=1 without ciphertext is rejected",
			extra:      map[string]string{"encryption_version": "1", "sender_device_id": "dev-1"},
			wantStatus: http.StatusBadRequest,
			wantError:  "encryption_version=1 requires both ciphertext and sender_device_id",
		},
		{
			name:       "encryption_version=1 without sender_device_id is rejected",
			extra:      map[string]string{"encryption_version": "1", "ciphertext": "blob"},
			wantStatus: http.StatusBadRequest,
			wantError:  "encryption_version=1 requires both ciphertext and sender_device_id",
		},
		{
			name:       "ciphertext smuggled in without the version flag is rejected",
			extra:      map[string]string{"ciphertext": "blob"},
			wantStatus: http.StatusBadRequest,
			wantError:  "ciphertext/sender_device_id provided without encryption_version=1",
		},
		{
			name:       "a complete E2EE payload is accepted",
			extra:      map[string]string{"encryption_version": "1", "ciphertext": "blob", "sender_device_id": "dev-1"},
			wantStatus: http.StatusCreated,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := NewMessageHandler(&stubMessageService{}, &stubUploadService{}, 1<<20, nil, nil)
			body, ct := multipartBody(t, "", nil, tc.extra)
			rec := httptest.NewRecorder()
			h.Create(rec, newCreateRequest(t, body, ct))

			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d (body %s)", rec.Code, tc.wantStatus, rec.Body.String())
			}
			if tc.wantError != "" {
				var env pkg.APIResponse
				if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
					t.Fatalf("unmarshal: %v", err)
				}
				if env.Error != tc.wantError {
					t.Errorf("error = %q, want %q", env.Error, tc.wantError)
				}
			}
		})
	}
}
