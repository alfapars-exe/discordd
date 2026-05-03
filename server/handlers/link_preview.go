package handlers

import (
	"net/http"

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

	preview, err := h.service.GetPreview(r.Context(), rawURL)
	if err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadGateway, "failed to fetch link preview")
		return
	}

	pkg.JSON(w, http.StatusOK, preview)
}
