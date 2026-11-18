// Package handlers — DiagnosticsHandler emails a user-submitted diagnostics
// bundle to the platform admin via the configured EmailSender (Resend over
// HTTP; outbound SMTP is blocked on the HF Space). The client also archives the
// same report through the feedback channel, so a missing email sender or a send
// failure is non-fatal here — we still return 204.
package handlers

import (
	"context"
	"io"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/email"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/services"
)

const maxDiagnosticsDescriptionLen = 4000

// maxConcurrentDiagnosticsEmails bounds the email goroutines: each one pins
// the full diagnostics bundle (up to maxSize bytes) in memory, so an
// unbounded spawn-per-request pattern is a memory-exhaustion vector.
const maxConcurrentDiagnosticsEmails = 4

// diagnosticsEmailTimeout caps a single Resend call so a hung upstream can't
// pin a semaphore slot (and its bundle payload) forever.
const diagnosticsEmailTimeout = 60 * time.Second

type DiagnosticsHandler struct {
	email     email.EmailSender
	reportTo  string
	appLogger services.AppLogService
	maxSize   int64
	emailSem  chan struct{}
	mu        sync.Mutex
	stopped   bool
	lifecycle context.Context
	cancel    context.CancelFunc
	workers   sync.WaitGroup
}

func NewDiagnosticsHandler(emailSender email.EmailSender, reportTo string, appLogger services.AppLogService, maxSize int64) *DiagnosticsHandler {
	ctx, cancel := context.WithCancel(context.Background())
	return &DiagnosticsHandler{
		lifecycle: ctx, cancel: cancel,
		email:     emailSender,
		reportTo:  reportTo,
		appLogger: appLogger,
		maxSize:   maxSize,
		emailSem:  make(chan struct{}, maxConcurrentDiagnosticsEmails),
	}
}

// Report handles POST /api/diagnostics-report (multipart: description + file).
//
//   - Requires auth (reporter is read from context).
//   - Body capped at maxSize via LimitedParseMultipartFormN.
//   - Emails the bundle to the admin asynchronously (best-effort). If no email
//     sender is configured (RESEND_API_KEY unset) the email is skipped silently.
//   - Always 204 — the durable copy is the feedback ticket the client also created.
func (h *DiagnosticsHandler) Report(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	if err := pkg.LimitedParseMultipartFormN(w, r, h.maxSize, 1); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid multipart form")
		return
	}

	description := r.FormValue("description")
	if len(description) > maxDiagnosticsDescriptionLen {
		description = description[:maxDiagnosticsDescriptionLen]
	}

	// The multipart header is deliberately discarded: its Filename is the only
	// field this handler ever read from it, and that is now a fixed constant
	// (see below).
	file, _, err := r.FormFile("file")
	if err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "file is required")
		return
	}
	defer file.Close()

	data, err := io.ReadAll(io.LimitReader(file, h.maxSize))
	if err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "failed to read file")
		return
	}

	// The attachment name is fixed, not derived from header.Filename
	// (security scan 2026-07-31, finding N-27). Every other upload path in the
	// codebase runs the client's name through pkg.SanitizeFilename; this one used
	// it raw, so a registered user could choose the filename that lands in the
	// platform admin's inbox -- "report.pdf.exe", a name carrying an
	// RTL-override, path separators, control characters.
	//
	// Pinning beats sanitizing here: this endpoint accepts exactly one thing,
	// the gzip bundle the client builds, so the client's name carries no
	// information worth keeping and the attacker-controlled string is removed
	// rather than filtered. The reporter is already identified in the subject
	// and body.
	const filename = "hichat-diagnostics.json.gz"

	// Email is best-effort and shouldn't hold the response on send latency.
	// Concurrency is bounded by emailSem; when all slots are busy we skip the
	// email instead of piling up goroutines that each pin the full bundle —
	// the feedback ticket the client also files is the durable copy.
	h.queueEmail(r.Context(), user, description, filename, data)

	w.WriteHeader(http.StatusNoContent)
}

// Stop closes email admission, cancels accepted sends and joins their logging.
// Call after HTTP drain and before app-log shutdown.
func (h *DiagnosticsHandler) Stop() {
	h.mu.Lock()
	h.stopped = true
	h.cancel()
	h.mu.Unlock()
	h.workers.Wait()
}

func (h *DiagnosticsHandler) queueEmail(requestCtx context.Context, user *models.User, description, filename string, data []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.stopped {
		return
	}
	if h.email != nil && h.reportTo != "" {
		uid := user.ID
		reporter := user.Username
		select {
		case h.emailSem <- struct{}{}:
			h.workers.Add(1)
			go func() {
				defer h.workers.Done()
				logx.Run("diagnostics.email", func() {
					defer func() { <-h.emailSem }()
					ctx, cancel := context.WithTimeout(h.lifecycle, diagnosticsEmailTimeout)
					defer cancel()
					if sendErr := h.email.SendDiagnosticsReport(ctx, h.reportTo, reporter, description, filename, data); sendErr != nil {
						h.appLogger.Log(ctx, models.LogLevelError, models.LogCategoryGeneral, &uid, nil,
							"diagnostics_email_failed", map[string]string{"error": pkg.ErrText(sendErr)})
					} else {
						h.appLogger.Log(ctx, models.LogLevelInfo, models.LogCategoryGeneral, &uid, nil,
							"diagnostics_email_sent", map[string]string{"to": h.reportTo, "bytes": strconv.Itoa(len(data))})
					}
				})
			}()
		default:
			h.appLogger.Log(requestCtx, models.LogLevelWarn, models.LogCategoryGeneral, &uid, nil,
				"diagnostics_email_skipped_backpressure", map[string]string{"bytes": strconv.Itoa(len(data))})
		}
	}

}
