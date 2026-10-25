package handlers

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
)

// LinkPreviewHandler fetches Open Graph metadata for URLs.
// SSRF protection is in the service layer.
type LinkPreviewHandler struct {
	service services.LinkPreviewService
}

func NewLinkPreviewHandler(service services.LinkPreviewService) *LinkPreviewHandler {
	return &LinkPreviewHandler{service: service}
}

// Get returns Open Graph metadata for the given URL.
// GET /api/link-preview?url=https://example.com
func (h *LinkPreviewHandler) Get(w http.ResponseWriter, r *http.Request) {
	_, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	rawURL := r.URL.Query().Get("url")
	if rawURL == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "url parameter is required")
		return
	}

	start := time.Now()
	preview, err := h.service.GetPreview(r.Context(), rawURL)
	if err != nil {
		if errors.Is(err, context.Canceled) {
			if r.Context().Err() == nil {
				pkg.ClaimRequestError(r.Context())
				pkg.ErrorWithCode(w, http.StatusServiceUnavailable, "preview service stopping", "PREVIEW_STOPPING")
			}
			return
		}
		status, code, kind := services.LinkPreviewFailureInfo(err)
		if kind == "cached" {
			pkg.ClaimRequestError(r.Context())
		}
		host := ""
		if parsed, e := url.Parse(rawURL); e == nil {
			host = parsed.Hostname()
		}
		if kind == "cached" {
			pkg.ErrorWithCode(w, status, "failed to fetch link preview", code)
		} else {
			pkg.ErrorCtxCode(r.Context(), w, status, "failed to fetch link preview", code, kind, err, slog.String("component", "link_preview"), slog.String("host", host), slog.Int64("duration_ms", time.Since(start).Milliseconds()))
		}
		return
	}

	pkg.JSON(w, http.StatusOK, preview)
}
