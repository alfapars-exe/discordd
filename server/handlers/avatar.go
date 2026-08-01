// Package handlers -- AvatarHandler: user avatar and server icon upload endpoints.
//
// Separate from UploadService because avatar uploads update User/Server records
// directly (no messageID or Attachment record), and only files that
// successfully decode as images (via ResizeAvatarBytes) are accepted --
// see processUpload.
package handlers

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/ratelimit"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/services"
)

const avatarMaxSize = 8 << 20 // 8MB

// retryAfterHeader is the standard HTTP header used to tell a rate-limited
// client how long to wait before retrying.
const retryAfterHeader = "Retry-After"

// AvatarHandler handles avatar and icon upload endpoints.
// uploadLimiter is the same per-user upload budget MessageHandler/DMHandler
// apply to multipart message attachments (message.go) — avatars share the
// storage/bandwidth cost concern, so they share the limiter wiring.
type AvatarHandler struct {
	userRepo      repository.UserRepository
	memberService services.MemberService
	serverService services.ServerService
	uploadDir     string
	uploadLimiter *ratelimit.MessageRateLimiter
}

func NewAvatarHandler(
	userRepo repository.UserRepository,
	memberService services.MemberService,
	serverService services.ServerService,
	uploadDir string,
	uploadLimiter *ratelimit.MessageRateLimiter,
) *AvatarHandler {
	return &AvatarHandler{
		userRepo:      userRepo,
		memberService: memberService,
		serverService: serverService,
		uploadDir:     uploadDir,
		uploadLimiter: uploadLimiter,
	}
}

// rateLimited checks the upload limiter for userID and, if the budget is
// exhausted, writes the Retry-After header plus a 429 response body and
// returns true so the caller can bail out. A nil limiter (disabled) or a
// user still within budget returns false without writing anything.
func (h *AvatarHandler) rateLimited(w http.ResponseWriter, userID string) bool {
	if h.uploadLimiter == nil || h.uploadLimiter.Allow(userID) {
		return false
	}

	retryAfter := h.uploadLimiter.CooldownSeconds(userID)
	w.Header().Set(retryAfterHeader, fmt.Sprintf("%d", retryAfter))
	pkg.ErrorWithMessage(w, http.StatusTooManyRequests,
		fmt.Sprintf("too many uploads, please wait %s",
			ratelimit.FormatRetryMessage(retryAfter)))
	return true
}

// UploadUserAvatar uploads the current user's avatar.
// Deletes the old avatar file from disk if present.
// POST /api/users/me/avatar (multipart/form-data)
func (h *AvatarHandler) UploadUserAvatar(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	if h.rateLimited(w, user.ID) {
		return
	}

	fileURL, err := h.processUpload(w, r)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	h.deleteOldFile(user.AvatarURL)

	// Update via MemberService to get WS broadcast for free
	member, err := h.memberService.UpdateProfile(r.Context(), user.ID, &models.UpdateProfileRequest{
		AvatarURL: &fileURL,
	})
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, member)
}

// UploadUserWallpaper uploads the current user's wallpaper.
// Deletes the old wallpaper file from disk if present.
// POST /api/users/me/wallpaper (multipart/form-data)
func (h *AvatarHandler) UploadUserWallpaper(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	if h.rateLimited(w, user.ID) {
		return
	}

	fileURL, err := h.processUpload(w, r)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	h.deleteOldFile(user.WallpaperURL)

	if err := h.userRepo.UpdateWallpaper(r.Context(), user.ID, &fileURL); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"wallpaper_url": fileURL})
}

// DeleteUserWallpaper removes the current user's wallpaper (file + DB column).
// DELETE /api/users/me/wallpaper
func (h *AvatarHandler) DeleteUserWallpaper(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	h.deleteOldFile(user.WallpaperURL)

	if err := h.userRepo.UpdateWallpaper(r.Context(), user.ID, nil); err != nil {
		pkg.Error(w, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// UploadServerIcon uploads the server icon. Requires admin permission.
// Deletes the old icon file from disk if present.
// POST /api/servers/{serverId}/icon (multipart/form-data)
func (h *AvatarHandler) UploadServerIcon(w http.ResponseWriter, r *http.Request) {
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}

	// This route doesn't otherwise need the caller's user record (permission
	// is already enforced by authServerPerm upstream) — it's read here only
	// to key the upload limiter. If it's missing for any reason, skip the
	// limiter rather than reject the request; don't change this route's
	// existing auth behavior.
	if user, ok := r.Context().Value(UserContextKey).(*models.User); ok {
		if h.rateLimited(w, user.ID) {
			return
		}
	}

	fileURL, err := h.processUpload(w, r)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	currentServer, err := h.serverService.GetServer(r.Context(), serverID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	h.deleteOldFile(currentServer.IconURL)

	server, err := h.serverService.UpdateIcon(r.Context(), serverID, fileURL)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, server)
}

// processUpload parses the multipart form, validates the file, and saves it to disk.
// Returns the URL path (e.g. "/api/uploads/a1b2c3d4_avatar.png").
// w is forwarded to MaxBytesReader so the body cap takes effect before the
// parser starts spilling to disk; callers always pass their handler's
// ResponseWriter.
func (h *AvatarHandler) processUpload(w http.ResponseWriter, r *http.Request) (string, error) {
	if err := pkg.LimitedParseMultipartForm(w, r, avatarMaxSize); err != nil {
		return "", fmt.Errorf("%w: failed to parse multipart form", pkg.ErrBadRequest)
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		return "", fmt.Errorf("%w: file field is required", pkg.ErrBadRequest)
	}
	defer file.Close()

	if header.Size > avatarMaxSize {
		return "", fmt.Errorf("%w: file too large (max 8MB)", pkg.ErrBadRequest)
	}

	// No client-declared-MIME allowlist here on purpose: the multipart
	// Content-Type header is attacker-controlled and was never actually
	// validated against the file bytes. ResizeAvatarBytes below is the only
	// gate — the binary links exactly one decoder set (jpeg/png/gif/webp;
	// see image_resize.go's imports and pkg/thumbnail's matching set), so a
	// successful full decode IS proof of allowlist membership, and it comes
	// from the real bytes instead of a 512-byte sniff.
	//
	// Downscale + re-encode before touching disk. ResizeAvatarBytes decodes
	// any image format the binary supports, caps the longest edge at
	// avatarMaxDim, and returns the encoder-chosen extension (.png for
	// alpha, .jpg otherwise). The resize step also strips EXIF /
	// colour-profile metadata, so a user can't accidentally publish
	// GPS-tagged photos as their avatar.
	//
	// Pre-resize avatars routinely hit ~1.3 MiB on disk (the Lighthouse audit
	// from Mayıs 28 2026 showed five concurrent member-list avatars eating
	// ~5.9 MiB of bandwidth). Post-resize each one fits in ~6-15 KB.
	resized, ext, err := ResizeAvatarBytes(file)
	if err != nil {
		if errors.Is(err, ErrImageTooLarge) {
			return "", fmt.Errorf("%w: %v", pkg.ErrBadRequest, err)
		}
		return "", fmt.Errorf("%w: only image files are allowed (jpeg, png, gif, webp)", pkg.ErrBadRequest)
	}

	randomBytes := make([]byte, 8)
	if _, err := rand.Read(randomBytes); err != nil {
		return "", fmt.Errorf("failed to generate random filename: %w", err)
	}
	safeFilename := sanitizeAvatarFilename(header.Filename)
	// Replace the original extension with the one chosen by the resizer —
	// a .png upload re-encoded as JPEG must land on disk as .jpg so the
	// MIME sniff at serve time matches the actual bytes.
	safeFilename = SwapExtension(safeFilename, ext)
	diskFilename := hex.EncodeToString(randomBytes) + "_" + safeFilename

	destPath, err := pkg.SafeJoin(h.uploadDir, diskFilename)
	if err != nil {
		return "", fmt.Errorf("%w: invalid upload destination", pkg.ErrBadRequest)
	}
	if err := os.WriteFile(destPath, resized, 0o600); err != nil { // #nosec G304,G703 -- verified by SafeJoin (pkg/safepath.go: rejects .., absolute paths, and any resolved path outside baseDir)
		return "", fmt.Errorf("failed to save file: %w", err)
	}

	return "/api/uploads/" + diskFilename, nil
}

// deleteOldFile removes a previous avatar/icon file from disk.
// Silently ignores missing files -- not critical.
func (h *AvatarHandler) deleteOldFile(fileURL *string) {
	if fileURL == nil || *fileURL == "" {
		return
	}

	filename := filepath.Base(*fileURL)
	if filename == "." || filename == "/" {
		return
	}

	oldPath := filepath.Join(h.uploadDir, filename)
	os.Remove(oldPath)
}

// sanitizeAvatarFilename strips path traversal characters.
// Same logic as upload_service.go's sanitizeFilename (package-private, defined separately).
func sanitizeAvatarFilename(name string) string {
	name = filepath.Base(name)

	name = strings.Map(func(r rune) rune {
		if r == '/' || r == '\\' || r == '\x00' {
			return -1
		}
		return r
	}, name)

	if name == "" || name == "." || name == ".." {
		name = "unnamed"
	}

	return name
}
