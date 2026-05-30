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

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/email"
	"github.com/argeinfina/hichat/services"
)

const maxDiagnosticsDescriptionLen = 4000

type DiagnosticsHandler struct {
	email     email.EmailSender
	reportTo  string
	appLogger services.AppLogService
	maxSize   int64
}

func NewDiagnosticsHandler(emailSender email.EmailSender, reportTo string, appLogger services.AppLogService, maxSize int64) *DiagnosticsHandler {
	return &DiagnosticsHandler{email: emailSender, reportTo: reportTo, appLogger: appLogger, maxSize: maxSize}
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

	file, header, err := r.FormFile("file")
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

	filename := "hichat-diagnostics.json.gz"
	if header != nil && header.Filename != "" {
		filename = header.Filename
	}

	// Email is best-effort and shouldn't hold the response on send latency.
	if h.email != nil && h.reportTo != "" {
		uid := user.ID
		reporter := user.Username
		go func() {
			if sendErr := h.email.SendDiagnosticsReport(context.Background(), h.reportTo, reporter, description, filename, data); sendErr != nil {
				h.appLogger.Log(models.LogLevelError, models.LogCategoryGeneral, &uid, nil,
					"diagnostics_email_failed", map[string]string{"error": sendErr.Error()})
			} else {
				h.appLogger.Log(models.LogLevelInfo, models.LogCategoryGeneral, &uid, nil,
					"diagnostics_email_sent", map[string]string{"to": h.reportTo, "bytes": strconv.Itoa(len(data))})
			}
		}()
	}

	w.WriteHeader(http.StatusNoContent)
}
