package handlers

import (
	"encoding/base64"
	"errors"
	"html/template"
	"io"
	"mime"
	"net/http"
	"strings"
	"time"

	"github.com/argeinfina/hichat/pkg/ratelimit"
	"github.com/argeinfina/hichat/repository"
)

const maxEmailUnsubscribeFormBytes int64 = 1024

var emailUnsubscribePage = template.Must(template.New("email-unsubscribe").Parse(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Email preferences</title></head>
<body>
<main>
  <h1>Email preferences</h1>
  {{if .Consumed}}
  <p>This unsubscribe link has already been used.</p>
  {{else if .Complete}}
  <p>Your email preference has been updated.</p>
  {{else}}
  <p>Confirm that you want to unsubscribe from {{.Category}} emails.</p>
  <form method="post" action="{{.Action}}">
    <input type="hidden" name="token" value="{{.Token}}">
    <button type="submit">Confirm unsubscribe</button>
  </form>
  {{end}}
</main>
</body>
</html>`))

type EmailUnsubscribeHandler struct {
	repo    repository.EmailUnsubscribeRepository
	limiter *ratelimit.LoginRateLimiter
}

func NewEmailUnsubscribeHandler(repo repository.EmailUnsubscribeRepository, limiter *ratelimit.LoginRateLimiter) *EmailUnsubscribeHandler {
	return &EmailUnsubscribeHandler{repo: repo, limiter: limiter}
}

type emailUnsubscribePageData struct {
	Action   string
	Category string
	Token    string
	Consumed bool
	Complete bool
}

func (h *EmailUnsubscribeHandler) Confirm(w http.ResponseWriter, r *http.Request) {
	setEmailUnsubscribeHeaders(w)
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if h.rateLimited(w, r) {
		return
	}
	tokens := r.URL.Query()["token"]
	if len(tokens) != 1 {
		emailUnsubscribeError(w, http.StatusBadRequest)
		return
	}
	token := tokens[0]
	if !validEmailUnsubscribeFormToken(token) {
		emailUnsubscribeError(w, http.StatusBadRequest)
		return
	}
	if h == nil || h.repo == nil {
		emailUnsubscribeError(w, http.StatusServiceUnavailable)
		return
	}
	state, err := h.repo.Inspect(r.Context(), token, emailUnsubscribeNow())
	if errors.Is(err, repository.ErrEmailUnsubscribeInvalid) {
		emailUnsubscribeError(w, http.StatusBadRequest)
		return
	}
	if err != nil {
		emailUnsubscribeError(w, http.StatusServiceUnavailable)
		return
	}
	data := emailUnsubscribePageData{Action: r.URL.Path, Category: state.Category, Token: token, Consumed: state.Consumed}
	emailUnsubscribeRender(w, data)
}

func (h *EmailUnsubscribeHandler) Unsubscribe(w http.ResponseWriter, r *http.Request) {
	setEmailUnsubscribeHeaders(w)
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if h.rateLimited(w, r) {
		return
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/x-www-form-urlencoded" {
		emailUnsubscribeError(w, http.StatusBadRequest)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxEmailUnsubscribeFormBytes)
	if err := r.ParseForm(); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			emailUnsubscribeError(w, http.StatusRequestEntityTooLarge)
			return
		}
		emailUnsubscribeError(w, http.StatusBadRequest)
		return
	}
	values := r.PostForm["token"]
	if len(values) != 1 || !validEmailUnsubscribeFormToken(values[0]) {
		emailUnsubscribeError(w, http.StatusBadRequest)
		return
	}
	if h == nil || h.repo == nil {
		emailUnsubscribeError(w, http.StatusServiceUnavailable)
		return
	}
	if err := h.repo.Consume(r.Context(), values[0], emailUnsubscribeNow()); errors.Is(err, repository.ErrEmailUnsubscribeInvalid) {
		emailUnsubscribeError(w, http.StatusBadRequest)
		return
	} else if err != nil {
		emailUnsubscribeError(w, http.StatusServiceUnavailable)
		return
	}
	emailUnsubscribeRender(w, emailUnsubscribePageData{Complete: true})
}

func (h *EmailUnsubscribeHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.Confirm(w, r)
	case http.MethodPost:
		h.Unsubscribe(w, r)
	default:
		setEmailUnsubscribeHeaders(w)
		w.Header().Set("Allow", "GET, POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (h *EmailUnsubscribeHandler) rateLimited(w http.ResponseWriter, r *http.Request) bool {
	if h != nil && h.limiter != nil && !h.limiter.Allow(ratelimit.ExtractIP(r)) {
		w.Header().Set("Retry-After", "300")
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = io.WriteString(w, "Too many unsubscribe attempts. Please try again later.\n")
		return true
	}
	return false
}

func emailUnsubscribeNow() time.Time { return time.Now().UTC() }

func validEmailUnsubscribeFormToken(token string) bool {
	if len(token) != 43 || strings.TrimSpace(token) != token {
		return false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(token)
	return err == nil && len(decoded) == 32 && base64.RawURLEncoding.EncodeToString(decoded) == token
}

func setEmailUnsubscribeHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
}

func emailUnsubscribeError(w http.ResponseWriter, status int) {
	message := "The unsubscribe link is invalid or expired."
	if status == http.StatusServiceUnavailable {
		message = "Email preferences are temporarily unavailable. Please try again later."
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, message+"\n")
}

func emailUnsubscribeRender(w http.ResponseWriter, data emailUnsubscribePageData) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := emailUnsubscribePage.Execute(w, data); err != nil {
		// Rendering is static and template-escaped; do not log request tokens.
		return
	}
}
