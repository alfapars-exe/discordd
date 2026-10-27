package handlers

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

type dataExportHandlerRepo struct {
	downloaderID string
	ownerID      string
	archive      io.ReadCloser
	archiveSize  int64
	archiveErr   error
	job          *models.DataExportJob
}

func (r *dataExportHandlerRepo) Create(context.Context, *models.User) (*models.DataExportJob, error) {
	return r.job, nil
}
func (r *dataExportHandlerRepo) Get(_ context.Context, ownerID, id string) (*models.DataExportJob, error) {
	r.ownerID, r.downloaderID = ownerID, id
	if r.job == nil {
		return nil, pkg.ErrNotFound
	}
	return r.job, nil
}
func (r *dataExportHandlerRepo) Download(context.Context, string, string) ([]byte, error) {
	return nil, nil
}
func (r *dataExportHandlerRepo) DownloadAttachments(_ context.Context, ownerID, id string) (io.ReadCloser, int64, error) {
	r.ownerID, r.downloaderID = ownerID, id
	return r.archive, r.archiveSize, r.archiveErr
}
func (r *dataExportHandlerRepo) PurgeExpired(context.Context) error         { return nil }
func (r *dataExportHandlerRepo) StartPendingArchives(context.Context) error { return nil }
func (r *dataExportHandlerRepo) StopArchiveWorker(context.Context) error    { return nil }

func authenticatedExportRequest(method, path string, userID string) *http.Request {
	r := httptest.NewRequest(method, path, nil)
	r.SetPathValue("id", "abcdefghijklmnop")
	r = withUser(r, &models.User{ID: userID})
	return r.WithContext(context.WithValue(r.Context(), AuthSessionContextKey, "test-session"))
}

func TestDataExportAttachmentDownloadIsOwnerScopedAndNoStore(t *testing.T) {
	repo := &dataExportHandlerRepo{archive: io.NopCloser(strings.NewReader("zip")), archiveSize: 3}
	handler := NewDataExportHandler(repo)
	w := httptest.NewRecorder()
	handler.DownloadAttachments(w, authenticatedExportRequest(http.MethodGet, "/api/users/me/data-exports/abcdefghijklmnop/attachments", "owner-123"))
	if w.Code != http.StatusOK || w.Body.String() != "zip" {
		t.Fatalf("download response = %d %q", w.Code, w.Body.String())
	}
	if repo.ownerID != "owner-123" || repo.downloaderID != "abcdefghijklmnop" {
		t.Fatalf("repository scope = owner %q export %q", repo.ownerID, repo.downloaderID)
	}
	if got := w.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
	if got := w.Header().Get("Content-Type"); got != "application/zip" {
		t.Fatalf("Content-Type = %q", got)
	}
	if got := w.Header().Get("Content-Length"); got != "3" {
		t.Fatalf("Content-Length = %q", got)
	}
	if got := w.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("nosniff = %q", got)
	}
	if got := w.Header().Get("Content-Disposition"); !strings.Contains(got, "hichat-data-abcdefghijkl-attachments.zip") {
		t.Fatalf("Content-Disposition = %q", got)
	}
}

func TestDataExportAttachmentDownloadDoesNotPublishMissingOrFailedArchive(t *testing.T) {
	repo := &dataExportHandlerRepo{archiveErr: pkg.ErrNotFound}
	handler := NewDataExportHandler(repo)
	w := httptest.NewRecorder()
	handler.DownloadAttachments(w, authenticatedExportRequest(http.MethodGet, "/api/users/me/data-exports/abcdefghijklmnop/attachments", "owner-123"))
	if w.Code != http.StatusNotFound {
		t.Fatalf("missing/expired archive status = %d, want 404", w.Code)
	}
	if w.Body.String() == "" || strings.Contains(w.Body.String(), "zip") {
		t.Fatalf("unexpected error body: %q", w.Body.String())
	}
	if got := w.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
}

func TestDataExportGetExposesFailedAttachmentState(t *testing.T) {
	errorCode := "archive_unavailable"
	repo := &dataExportHandlerRepo{job: &models.DataExportJob{ID: "abcdefghijklmnop", Status: "ready", AttachmentsStatus: "failed", AttachmentsError: &errorCode}}
	handler := NewDataExportHandler(repo)
	w := httptest.NewRecorder()
	handler.Get(w, authenticatedExportRequest(http.MethodGet, "/api/users/me/data-exports/abcdefghijklmnop", "owner-123"))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"attachments_status":"failed"`) || !strings.Contains(w.Body.String(), `"attachments_error":"archive_unavailable"`) {
		t.Fatalf("failed attachment job response = %d %s", w.Code, w.Body.String())
	}
}
