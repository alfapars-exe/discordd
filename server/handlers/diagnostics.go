// Package handlers — DiagnosticsHandler emails a user-submitted diagnostics
// bundle to the platform admin via SMTP (Gmail). The client also archives the
// same report through the feedback channel, so a missing SMTP config or a send
// failure is non-fatal here — we still return 204.
package handlers

import (
	"io"
	"net/http"
	"strconv"

	"github.com/argeinfina/hichat/config"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/email"
	"github.com/argeinfina/hichat/services"
)

const maxDiagnosticsDescriptionLen = 4000

type DiagnosticsHandler struct {
	smtp      config.DiagSMTPConfig
	appLogger services.AppLogService
	maxSize   int64
}

func NewDiagnosticsHandler(smtp config.DiagSMTPConfig, appLogger services.AppLogService, maxSize int64) *DiagnosticsHandler {
	return &DiagnosticsHandler{smtp: smtp, appLogger: appLogger, maxSize: maxSize}
}

// Report handles POST /api/diagnostics-report (multipart: description + file).
//
//   - Requires auth (reporter is read from context).
//   - Body capped at maxSize via LimitedParseMultipartFormN.
//   - Emails the bundle to the admin asynchronously (best-effort). If SMTP isn't
//     configured (User/Pass/To empty) the email is skipped silently.
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

	// Email is best-effort and shouldn't hold the response on SMTP latency.
	if h.smtp.User != "" && h.smtp.Pass != "" && h.smtp.To != "" {
		uid := user.ID
		reporter := user.Username
		smtpCfg := email.SMTPConfig{
			Host: h.smtp.Host,
			Port: h.smtp.Port,
			User: h.smtp.User,
			Pass: h.smtp.Pass,
			From: h.smtp.From,
			To:   h.smtp.To,
		}
		go func() {
			if sendErr := email.SendDiagnosticsReport(smtpCfg, reporter, description, filename, data); sendErr != nil {
				h.appLogger.Log(models.LogLevelError, models.LogCategoryGeneral, &uid, nil,
					"diagnostics_email_failed", map[string]string{"error": sendErr.Error()})
			} else {
				h.appLogger.Log(models.LogLevelInfo, models.LogCategoryGeneral, &uid, nil,
					"diagnostics_email_sent", map[string]string{"to": smtpCfg.To, "bytes": strconv.Itoa(len(data))})
			}
		}()
	}

	w.WriteHeader(http.StatusNoContent)
}
