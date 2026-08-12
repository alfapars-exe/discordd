package handlers

import (
	"net/http"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
)

type SearchHandler struct {
	searchService services.SearchService
}

func NewSearchHandler(searchService services.SearchService) *SearchHandler {
	return &SearchHandler{searchService: searchService}
}

// Search handles GET /api/servers/{serverId}/search?q=query&channel_id=optional&limit=25&offset=0
// FTS5 full-text search scoped to the server's channels, further filtered by
// the caller's own channel-read permission (H-05) — the service, not this
// handler, resolves and applies that filter.
func (h *SearchHandler) Search(w http.ResponseWriter, r *http.Request) {
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	query := r.URL.Query().Get("q")
	if query == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "query parameter 'q' is required")
		return
	}

	var channelID *string
	if cid := r.URL.Query().Get("channel_id"); cid != "" {
		channelID = &cid
	}

	limit, offset := pkg.ClampPagination(r, 25, 100)

	result, err := h.searchService.Search(r.Context(), serverID, user.ID, query, channelID, limit, offset)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, result)
}
