package handlers

import (
	"net/http"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
)

type PersonalizationHandler struct {
	service services.PersonalizationService
}

func NewPersonalizationHandler(service services.PersonalizationService) *PersonalizationHandler {
	return &PersonalizationHandler{service: service}
}

func (h *PersonalizationHandler) Recommendations(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok || user == nil || user.IsBot {
		pkg.Error(w, pkg.ErrUnauthorized)
		return
	}
	result, err := h.service.Recommendations(r.Context(), user.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, result)
}
