// Package handlers -- BadgeHandler: badge CRUD and user-badge assignment endpoints.
package handlers

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
)

const badgeIconMaxSize = 2 << 20 // 2MB

// BadgeHandler handles badge management endpoints.
type BadgeHandler struct {
	badgeService services.BadgeService
	uploadDir    string
}

// NewBadgeHandler creates a new BadgeHandler.
func NewBadgeHandler(badgeService services.BadgeService, uploadDir string) *BadgeHandler {
	return &BadgeHandler{badgeService: badgeService, uploadDir: uploadDir}
}

// ListBadges handles GET /api/badges
func (h *BadgeHandler) ListBadges(w http.ResponseWriter, r *http.Request) {
	badges, err := h.badgeService.ListBadges(r.Context())
	if err != nil {
		pkg.Error(w, err)
		return
	}
	if badges == nil {
		badges = []models.Badge{}
	}
	pkg.JSON(w, http.StatusOK, badges)
}

// CreateBadge handles POST /api/badges
func (h *BadgeHandler) CreateBadge(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req models.CreateBadgeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	badge, err := h.badgeService.CreateBadge(r.Context(), user.ID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusCreated, badge)
}

// UpdateBadge handles PATCH /api/badges/{id}
func (h *BadgeHandler) UpdateBadge(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	badgeID := r.PathValue("id")

	var req models.CreateBadgeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	badge, err := h.badgeService.UpdateBadge(r.Context(), user.ID, badgeID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, badge)
}

// DeleteBadge handles DELETE /api/badges/{id}
func (h *BadgeHandler) DeleteBadge(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	badgeID := r.PathValue("id")

	if err := h.badgeService.DeleteBadge(r.Context(), user.ID, badgeID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "badge deleted"})
}

// AssignBadge handles POST /api/badges/{id}/assign
func (h *BadgeHandler) AssignBadge(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	badgeID := r.PathValue("id")

	var body struct {
		UserID string `json:"user_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if body.UserID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "user_id is required")
		return
	}

	ub, err := h.badgeService.AssignBadge(r.Context(), user.ID, body.UserID, badgeID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, ub)
}

// UnassignBadge handles DELETE /api/badges/{id}/assign/{userId}
func (h *BadgeHandler) UnassignBadge(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	badgeID := r.PathValue("id")
	targetUserID := r.PathValue("userId")

	if err := h.badgeService.UnassignBadge(r.Context(), user.ID, targetUserID, badgeID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "badge unassigned"})
}

// GetUserBadges handles GET /api/users/{userId}/badges
func (h *BadgeHandler) GetUserBadges(w http.ResponseWriter, r *http.Request) {
	userID := r.PathValue("userId")

	badges, err := h.badgeService.GetUserBadges(r.Context(), userID)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	if badges == nil {
		badges = []models.UserBadge{}
	}

	pkg.JSON(w, http.StatusOK, badges)
}

// UploadBadgeIcon handles POST /api/badges/icon (multipart/form-data)
// Saves the icon image to disk and returns the URL path.
func (h *BadgeHandler) UploadBadgeIcon(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	// Only badge admin can upload icons
	if user.ID != services.BadgeAdminUserID {
		pkg.ErrorWithMessage(w, http.StatusForbidden, "only badge admin can upload icons")
		return
	}

	if err := pkg.LimitedParseMultipartForm(w, r, badgeIconMaxSize); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "failed to parse multipart form")
		return
	}

	// header (multipart.FileHeader) is intentionally discarded: the
	// destination filename is generated server-side from the sniffed MIME
	// (see mimeToExt below), never from the client-supplied header.Filename.
	file, _, err := r.FormFile("icon")
	if err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "icon file is required")
		return
	}
	defer file.Close()

	// Validate content: the client-declared Content-Type header is
	// attacker-controlled, so the allowlist decision is derived from the
	// bytes themselves (pkg.SniffContentType), never from the claim.
	//
	// SVG is deliberately NOT accepted, even though the real serving path
	// (/api/uploads/badges/…, see the URL comment below) re-sniffs at
	// serve time and would force any SVG to a non-displayable download —
	// making it safe to accept. It's rejected anyway: Go's sniffer can
	// never itself produce "image/svg+xml" (an XML-prolog SVG sniffs as
	// "text/xml", a bare "<svg" root as "text/plain"), so honoring an SVG
	// upload would require trusting the client's Content-Type claim over
	// those two generic, easily-spoofed sniffed results — and there is no
	// path left that can render an accepted SVG inline for the icon to be
	// worth that trust. See handlers/upload_download.go's serveFile for the
	// re-sniff/nosniff/CSP-sandbox behavior this reasoning relies on.
	sniffed, replay, err := pkg.SniffContentType(file)
	if err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "unreadable upload")
		return
	}

	var effectiveMIME string
	switch {
	case allowedBadgeIconSniffedMimes[sniffed]:
		effectiveMIME = sniffed
	default:
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "only PNG, JPEG, GIF, and WEBP are allowed")
		return
	}

	// Generate filename. The extension comes from the validated MIME, never
	// from header.Filename: mimeToExt maps the allow-listed set above onto a
	// fixed set of literals, so no part of the destination path is derived
	// from client input. Trusting filepath.Ext(header.Filename) instead meant
	// the stored extension could disagree with the actual bytes, and left the
	// only thing standing between an attacker-chosen suffix and the filesystem
	// as SafeJoin — correct, but the last line rather than the only one.
	randBytes := make([]byte, 8)
	_, _ = rand.Read(randBytes)
	filename := fmt.Sprintf("badge_%s%s", hex.EncodeToString(randBytes), mimeToExt(effectiveMIME))

	// Ensure badges subdirectory exists. 0750: group-readable for the
	// operator, closed to "other" so a shared host can't enumerate badges.
	badgesDir := filepath.Join(h.uploadDir, "badges")
	if err := os.MkdirAll(badgesDir, 0o750); err != nil {
		pkg.ErrorCtx(r.Context(), w, http.StatusInternalServerError, "failed to create badges directory", err)
		return
	}

	// Write file. SafeJoin enforces the destination stays inside badgesDir
	// even though filename was generated server-side — a future refactor
	// pulling filename from request data would otherwise become a traversal.
	destPath, err := pkg.SafeJoin(badgesDir, filename)
	if err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid filename")
		return
	}
	// Write to a temp file in the same directory, then rename into place.
	//
	// Publishing atomically is the point: badges are served straight off disk
	// by the /api/uploads/ handler (see the URL comment below), so writing
	// directly to destPath would expose a half-written icon at its final URL
	// for the duration of the copy, and a failure would leave that truncated
	// file behind for the cleanup to chase. os.Rename within one directory is
	// atomic, so the icon either does not exist or is complete.
	//
	// It also keeps the cleanup path off any request-derived value: the temp
	// name comes from os.CreateTemp, so nothing user-controlled reaches
	// os.Remove. destPath itself is still SafeJoin-verified.
	tmp, err := os.CreateTemp(badgesDir, ".upload-*")
	if err != nil {
		pkg.ErrorCtx(r.Context(), w, http.StatusInternalServerError, "failed to save icon", err)
		return
	}
	tmpPath := tmp.Name()
	// Safety net for the early returns below; the success path has already
	// renamed the file away, so this becomes a no-op there.
	defer func() { _ = os.Remove(tmpPath) }()

	// Close before any rename/remove — Windows refuses both while the handle
	// is open. Close is checked because a buffered write failure surfaces
	// there and nowhere else; discarding it would publish a truncated icon.
	_, copyErr := io.Copy(tmp, replay)
	closeErr := tmp.Close()
	if copyErr != nil {
		pkg.ErrorCtx(r.Context(), w, http.StatusInternalServerError, "failed to write icon", copyErr)
		return
	}
	if closeErr != nil {
		pkg.ErrorCtx(r.Context(), w, http.StatusInternalServerError, "failed to finalize icon", closeErr)
		return
	}
	// #nosec G703 -- destPath is the SafeJoin result verified above; tmpPath is
	// os.CreateTemp's own name inside the same directory. Neither operand is a
	// raw request value, but the taint tracker cannot see through SafeJoin.
	if err := os.Rename(tmpPath, destPath); err != nil {
		pkg.ErrorCtx(r.Context(), w, http.StatusInternalServerError, "failed to publish icon", err)
		return
	}

	// Return URL path under the auth-hardened /api/uploads/ handler. Plain
	// "/uploads/badges/…" is never mounted by anything — main.go only routes
	// "/api/", "/static/", and "/ws"; everything else falls through to the
	// SPA's index.html — so this MUST be the "/api/..." form or the returned
	// URL 404s (well, 200s with an HTML body) the moment a client requests
	// it. See handlers/upload_download.go's serveFile / media_access_service.go
	// for the re-sniff + nosniff + forced-download hardening this path gets
	// that a bare static handler wouldn't have had anyway.
	urlPath := "/api/uploads/badges/" + filename

	pkg.JSON(w, http.StatusCreated, map[string]string{"url": urlPath})
}

// allowedBadgeIconSniffedMimes is what http.DetectContentType actually
// returns for the four accepted raster formats. SVG is intentionally absent
// — see the doc comment above the sniff/allowlist check in UploadBadgeIcon.
var allowedBadgeIconSniffedMimes = map[string]bool{
	"image/jpeg": true,
	"image/png":  true,
	"image/gif":  true,
	"image/webp": true,
}

func mimeToExt(mime string) string {
	switch {
	case strings.Contains(mime, "png"):
		return ".png"
	case strings.Contains(mime, "jpeg"):
		return ".jpg"
	case strings.Contains(mime, "gif"):
		return ".gif"
	case strings.Contains(mime, "webp"):
		return ".webp"
	default:
		return ".png"
	}
}
