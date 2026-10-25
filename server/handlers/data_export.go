package handlers

import (
	"fmt"
	"net/http"

	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
)

type DataExportHandler struct {
	repo repository.DataExportRepository
}

func NewDataExportHandler(repo repository.DataExportRepository) *DataExportHandler {
	return &DataExportHandler{repo: repo}
}

func (h *DataExportHandler) Create(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, _, ok := sessionActor(w, r)
	if !ok {
		return
	}
	job, err := h.repo.Create(r.Context(), user)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusCreated, job)
}

func (h *DataExportHandler) Get(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, _, ok := sessionActor(w, r)
	if !ok {
		return
	}
	job, err := h.repo.Get(r.Context(), user.ID, r.PathValue("id"))
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, job)
}

func (h *DataExportHandler) Download(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, _, ok := sessionActor(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	payload, err := h.repo.Download(r.Context(), user.ID, id)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="hichat-data-%s.json"`, id[:12]))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(payload)
}
