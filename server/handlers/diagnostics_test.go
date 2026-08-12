// Diagnostics handler tests — the email fan-out is bounded by emailSem
// (regression for the unbounded-goroutine finding, 2026-06): each goroutine
// pins the full bundle in memory, so overflow requests must skip the email
// (and log) instead of queueing.
package handlers

import (
	"bytes"
	"context"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/testutil"
)

// stubAppLog records log messages synchronously for assertions.
type stubAppLog struct {
	mu       sync.Mutex
	messages []string
}

func (s *stubAppLog) Log(_ context.Context, _ models.LogLevel, _ models.LogCategory, _, _ *string, message string, _ map[string]string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.messages = append(s.messages, message)
}
func (s *stubAppLog) List(context.Context, models.AppLogFilter) ([]models.AppLog, int, error) {
	return nil, 0, nil
}
func (s *stubAppLog) Clear(context.Context) error { return nil }
func (s *stubAppLog) Start()                      {}
func (s *stubAppLog) Stop()                       {}

func (s *stubAppLog) count(msg string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, m := range s.messages {
		if m == msg {
			n++
		}
	}
	return n
}

var _ services.AppLogService = (*stubAppLog)(nil)

func newDiagnosticsRequest(t *testing.T) *http.Request {
	t.Helper()
	return newDiagnosticsRequestNamed(t, "diag.json.gz")
}

// newDiagnosticsRequestNamed lets a test choose the multipart filename, which
// is what finding N-27 was about: the handler used to pass it straight through
// to the outgoing mail attachment.
func newDiagnosticsRequestNamed(t *testing.T, uploadName string) *http.Request {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	if err := mw.WriteField("description", "test report"); err != nil {
		t.Fatalf("WriteField: %v", err)
	}
	fw, err := mw.CreateFormFile("file", uploadName)
	if err != nil {
		t.Fatalf("CreateFormFile: %v", err)
	}
	if _, err := fw.Write([]byte("payload-bytes")); err != nil {
		t.Fatalf("file write: %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("multipart close: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/diagnostics-report", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	user := &models.User{ID: "user-1", Username: "tester"}
	return req.WithContext(context.WithValue(req.Context(), UserContextKey, user))
}

// TestDiagnostics_SendsEmail — happy path: 204 + email carries reporter,
// description and the attachment bytes.
func TestDiagnostics_SendsEmail(t *testing.T) {
	type sent struct {
		reporter, description, filename string
		attachment                      []byte
	}
	got := make(chan sent, 1)
	email := &testutil.MockEmailSender{
		SendDiagnosticsReportFn: func(_ context.Context, _, reporter, description, filename string, attachment []byte) error {
			got <- sent{reporter, description, filename, attachment}
			return nil
		},
	}
	h := NewDiagnosticsHandler(email, "admin@example.com", &stubAppLog{}, 1<<20)

	rec := httptest.NewRecorder()
	h.Report(rec, newDiagnosticsRequest(t))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}

	select {
	case s := <-got:
		if s.reporter != "tester" || s.description != "test report" {
			t.Errorf("email reporter/description = %q/%q", s.reporter, s.description)
		}
		if string(s.attachment) != "payload-bytes" {
			t.Errorf("attachment = %q, want payload-bytes", s.attachment)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("email goroutine never fired")
	}
}

// TestDiagnostics_EmailConcurrencyBounded — 10 concurrent reports against
// blocking email sends: at most maxConcurrentDiagnosticsEmails goroutines may
// run, the rest must skip with a backpressure log, and every request still
// gets a 204.
func TestDiagnostics_EmailConcurrencyBounded(t *testing.T) {
	var inFlight, maxSeen atomic.Int32
	release := make(chan struct{})
	email := &testutil.MockEmailSender{
		SendDiagnosticsReportFn: func(_ context.Context, _, _, _, _ string, _ []byte) error {
			cur := inFlight.Add(1)
			defer inFlight.Add(-1)
			for {
				old := maxSeen.Load()
				if cur <= old || maxSeen.CompareAndSwap(old, cur) {
					break
				}
			}
			<-release
			return nil
		},
	}
	logs := &stubAppLog{}
	h := NewDiagnosticsHandler(email, "admin@example.com", logs, 1<<20)

	const n = 10
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rec := httptest.NewRecorder()
			h.Report(rec, newDiagnosticsRequest(t))
			if rec.Code != http.StatusNoContent {
				t.Errorf("status = %d, want 204", rec.Code)
			}
		}()
	}
	wg.Wait() // handlers return immediately; emails run async

	// Slots never free while release is closed-off, so exactly the buffered
	// acquisitions ran; everything else logged a synchronous skip.
	skipped := logs.count("diagnostics_email_skipped_backpressure")
	if skipped != n-maxConcurrentDiagnosticsEmails {
		t.Errorf("skipped = %d, want %d", skipped, n-maxConcurrentDiagnosticsEmails)
	}

	close(release)
	deadline := time.Now().Add(2 * time.Second)
	for inFlight.Load() != 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if got := maxSeen.Load(); got > maxConcurrentDiagnosticsEmails {
		t.Errorf("max concurrent email sends = %d, want <= %d", got, maxConcurrentDiagnosticsEmails)
	}
}

// TestDiagnostics_AttachmentNameIsFixed — REGRESSION GUARD, security scan
// 2026-07-31 finding N-27.
//
// The handler used to pass the multipart filename straight to the Resend
// attachment, so any registered user picked the filename that arrived in the
// platform admin's inbox. Every other upload path in this codebase runs the
// client's name through pkg.SanitizeFilename; this one was the exception.
//
// The fix pins the name rather than sanitizing it -- the endpoint accepts only
// the client's gzip bundle, so the supplied name carries nothing worth keeping.
// These cases therefore assert equality with the constant, not merely that the
// nasty parts were stripped: a sanitizer that only removed slashes would still
// let "report.pdf.exe" through.
func TestDiagnostics_AttachmentNameIsFixed(t *testing.T) {
	const want = "hichat-diagnostics.json.gz"

	// Only names that actually reach the handler belong here. A NUL byte and an
	// empty name are both refused by mime/multipart before r.FormFile returns,
	// so the request 400s and the attachment path is never entered -- asserting
	// 204 for those would be asserting something untrue about the stack.
	// TestDiagnostics_MalformedFilenameIsRejected below pins that instead.
	for _, uploadName := range []string{
		"report.pdf.exe",
		"../../../etc/passwd",
		`..\..\windows\system32\evil.bat`,
		// U+202E RIGHT-TO-LEFT OVERRIDE, written escaped rather than literal so
		// it stays visible in this file (staticcheck ST1018). A mail client
		// that honours it renders the name as "invoiceexe.jpg".
		"invoice\u202egpj.exe",
		"crlf\r\nInjected: yes", // header-shaped
	} {
		t.Run(strconv.Quote(uploadName), func(t *testing.T) {
			got := make(chan string, 1)
			email := &testutil.MockEmailSender{
				SendDiagnosticsReportFn: func(_ context.Context, _, _, _, filename string, _ []byte) error {
					got <- filename
					return nil
				},
			}
			h := NewDiagnosticsHandler(email, "admin@example.com", &stubAppLog{}, 1<<20)

			rec := httptest.NewRecorder()
			h.Report(rec, newDiagnosticsRequestNamed(t, uploadName))
			if rec.Code != http.StatusNoContent {
				t.Fatalf("status = %d, want 204", rec.Code)
			}

			select {
			case name := <-got:
				if name != want {
					t.Errorf("attachment filename = %q, want %q", name, want)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("email was never sent; the assertion never ran")
			}
		})
	}
}

// TestDiagnostics_MalformedFilenameIsRejected records where the boundary
// actually sits. A NUL byte or an empty multipart filename never reaches the
// handler: mime/multipart refuses them and r.FormFile returns an error, so the
// request is answered 400 and no mail is sent at all.
//
// Kept as a test rather than a comment because it is load-bearing for the
// finding above — it is the reason those two inputs are absent from the
// fixed-name table, and if a future Go release started accepting them the
// attachment path would silently gain two new inputs.
func TestDiagnostics_MalformedFilenameIsRejected(t *testing.T) {
	for _, uploadName := range []string{
		"bad\x00name.gz", // NUL
		"",               // no filename at all
	} {
		t.Run(strconv.Quote(uploadName), func(t *testing.T) {
			sent := make(chan struct{}, 1)
			email := &testutil.MockEmailSender{
				SendDiagnosticsReportFn: func(_ context.Context, _, _, _, _ string, _ []byte) error {
					sent <- struct{}{}
					return nil
				},
			}
			h := NewDiagnosticsHandler(email, "admin@example.com", &stubAppLog{}, 1<<20)

			rec := httptest.NewRecorder()
			h.Report(rec, newDiagnosticsRequestNamed(t, uploadName))
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400", rec.Code)
			}
			select {
			case <-sent:
				t.Error("an email was sent for a request the handler rejected")
			case <-time.After(200 * time.Millisecond):
			}
		})
	}
}
