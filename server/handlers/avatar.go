// Package handlers -- AvatarHandler: user avatar / profile banner and server
// icon upload endpoints.
//
// Separate from UploadService because avatar uploads update User/Server records
// directly (no messageID or Attachment record), and only files that
// successfully decode as images (ProcessAvatar / ResizeBannerBytes /
// ResizeAvatarBytes) are accepted -- see processUpload.
package handlers

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"

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

// imageBusyRetryAfter is the Retry-After (seconds) sent with the 503 for
// ErrImageBusy.
const imageBusyRetryAfter = "5"

// uploadKind selects processUpload's image pipeline and on-disk naming.
type uploadKind int

const (
	// kindAvatar — ProcessAvatar: static poster + optional animated GIF.
	kindAvatar uploadKind = iota
	// kindBanner — ResizeBannerBytes: static 5:2 banner.
	kindBanner
	// kindIcon / kindWallpaper — ResizeAvatarBytes (256 px, static), file
	// named after the sanitised upload name. Unchanged by the profile work.
	kindIcon
	kindWallpaper
)

// uploadResult carries the URL(s) processUpload wrote. AnimatedURL is nil
// unless an avatar upload was an animated GIF.
type uploadResult struct {
	URL         string
	AnimatedURL *string
}

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

// writeUploadError writes processUpload's error: ErrImageBusy becomes a 503
// with Retry-After, everything else goes through pkg.Error's sentinel map.
func writeUploadError(w http.ResponseWriter, err error) {
	if errors.Is(err, ErrImageBusy) {
		w.Header().Set(retryAfterHeader, imageBusyRetryAfter)
		pkg.ErrorWithMessage(w, http.StatusServiceUnavailable, ErrImageBusy.Error())
		return
	}
	pkg.Error(w, err)
}

// freshUser re-reads the caller's row. The auth middleware caches the user
// for up to 30 s, so the context copy can name an avatar / banner file that
// a newer upload already replaced — deleting by that stale name would leave
// the replaced file orphaned on disk.
func (h *AvatarHandler) freshUser(r *http.Request, userID string) (*models.User, error) {
	return h.userRepo.GetByID(r.Context(), userID)
}

// UploadUserAvatar uploads the current user's avatar. A multi-frame GIF also
// yields avatar_animated_url; any other upload clears it. The previous
// avatar files are deleted only after the DB update succeeds.
// POST /api/users/me/avatar (multipart/form-data)
func (h *AvatarHandler) UploadUserAvatar(w http.ResponseWriter, r *http.Request) {
	user, ok := profileAccountUser(w, r)
	if !ok {
		return
	}

	if h.rateLimited(w, user.ID) {
		return
	}

	fresh, err := h.freshUser(r, user.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	res, err := h.processUpload(w, r, kindAvatar)
	if err != nil {
		writeUploadError(w, err)
		return
	}

	// Update via MemberService to get WS broadcast for free
	member, err := h.memberService.UpdateProfile(r.Context(), user.ID, &models.UpdateProfileRequest{
		AvatarURL:         &res.URL,
		AvatarAnimatedURL: res.AnimatedURL,
	})
	if err != nil {
		h.deleteOldFile(&res.URL)
		h.deleteOldFile(res.AnimatedURL)
		pkg.Error(w, err)
		return
	}

	h.deleteOldFile(fresh.AvatarURL)
	h.deleteOldFile(fresh.AvatarAnimatedURL)

	pkg.JSON(w, http.StatusOK, member)
}

// UploadUserBanner uploads the current user's profile banner (static poster
// plus an optional safe animated GIF, both 5:2).
// POST /api/users/me/banner (multipart/form-data)
func (h *AvatarHandler) UploadUserBanner(w http.ResponseWriter, r *http.Request) {
	user, ok := profileAccountUser(w, r)
	if !ok {
		return
	}

	if h.rateLimited(w, user.ID) {
		return
	}

	fresh, err := h.freshUser(r, user.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	res, err := h.processUpload(w, r, kindBanner)
	if err != nil {
		writeUploadError(w, err)
		return
	}

	member, err := h.memberService.UpdateProfile(r.Context(), user.ID, &models.UpdateProfileRequest{
		BannerURL:         &res.URL,
		BannerAnimatedURL: res.AnimatedURL,
	})
	if err != nil {
		h.deleteOldFile(&res.URL)
		h.deleteOldFile(res.AnimatedURL)
		pkg.Error(w, err)
		return
	}

	h.deleteOldFile(fresh.BannerURL)
	h.deleteOldFile(fresh.BannerAnimatedURL)

	pkg.JSON(w, http.StatusOK, member)
}

// DeleteUserBanner removes the current user's profile banner (DB column,
// then file) and returns the updated member.
// DELETE /api/users/me/banner
func (h *AvatarHandler) DeleteUserBanner(w http.ResponseWriter, r *http.Request) {
	user, ok := profileAccountUser(w, r)
	if !ok {
		return
	}

	// Each removal broadcasts member_update to every server the user is in,
	// so it shares the upload budget.
	if h.rateLimited(w, user.ID) {
		return
	}

	fresh, err := h.freshUser(r, user.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	member, err := h.memberService.UpdateProfile(r.Context(), user.ID, &models.UpdateProfileRequest{
		ClearBanner: true,
	})
	if err != nil {
		pkg.Error(w, err)
		return
	}

	h.deleteOldFile(fresh.BannerURL)
	h.deleteOldFile(fresh.BannerAnimatedURL)

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

	res, err := h.processUpload(w, r, kindWallpaper)
	if err != nil {
		writeUploadError(w, err)
		return
	}
	fileURL := res.URL

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

	res, err := h.processUpload(w, r, kindIcon)
	if err != nil {
		writeUploadError(w, err)
		return
	}
	fileURL := res.URL

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

// processUpload parses the multipart form, runs the image pipeline chosen by
// kind, and saves the result to disk. Returns the URL path(s) (e.g.
// "/api/uploads/a1b2c3d4e5f6a7b8_avatar.png").
// w is forwarded to MaxBytesReader so the body cap takes effect before the
// parser starts spilling to disk; callers always pass their handler's
// ResponseWriter.
func (h *AvatarHandler) processUpload(w http.ResponseWriter, r *http.Request, kind uploadKind) (uploadResult, error) {
	if err := pkg.LimitedParseMultipartForm(w, r, avatarMaxSize); err != nil {
		return uploadResult{}, fmt.Errorf("%w: failed to parse multipart form", pkg.ErrBadRequest)
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		return uploadResult{}, fmt.Errorf("%w: file field is required", pkg.ErrBadRequest)
	}
	defer file.Close()

	if header.Size > avatarMaxSize {
		return uploadResult{}, fmt.Errorf("%w: file too large (max 8MB)", pkg.ErrBadRequest)
	}

	// No client-declared-MIME allowlist here on purpose: the multipart
	// Content-Type header is attacker-controlled and was never actually
	// validated against the file bytes. The image pipeline below is the only
	// gate — the binary links exactly one decoder set (jpeg/png/gif/webp;
	// see image_resize.go's imports and pkg/thumbnail's matching set), so a
	// successful full decode IS proof of allowlist membership, and it comes
	// from the real bytes instead of a 512-byte sniff.
	//
	// Every pipeline downscales + re-encodes before touching disk: it caps
	// the dimensions, returns the encoder-chosen extension (.png for alpha,
	// .jpg otherwise; .gif for the animated avatar copy), and strips EXIF /
	// colour-profile metadata, so a user can't accidentally publish
	// GPS-tagged photos as their avatar.
	//
	// Pre-resize avatars routinely hit ~1.3 MiB on disk (the Lighthouse audit
	// from Mayıs 28 2026 showed five concurrent member-list avatars eating
	// ~5.9 MiB of bandwidth). Post-resize each one fits in ~6-15 KB.
	var (
		data     []byte
		ext      string
		animated []byte
	)
	switch kind {
	case kindAvatar:
		var res AvatarResult
		res, err = ProcessAvatar(r.Context(), file)
		data, ext, animated = res.Static, res.StaticExt, res.Animated
	case kindBanner:
		var res AvatarResult
		res, err = ProcessBanner(r.Context(), file)
		data, ext, animated = res.Static, res.StaticExt, res.Animated
	default:
		data, ext, err = ResizeAvatarBytes(file)
	}
	if err != nil {
		return uploadResult{}, imagePipelineError(err)
	}

	// Avatar and banner files get fixed names (the CLI in cmd/resize_avatars
	// recognises "_banner." and skips it); icon / wallpaper keep the
	// sanitised upload name. The extension always comes from the encoder —
	// a .png upload re-encoded as JPEG must land on disk as .jpg so the
	// MIME sniff at serve time matches the actual bytes.
	var name string
	switch kind {
	case kindAvatar:
		name = "avatar" + ext
	case kindBanner:
		name = "banner" + ext
	default:
		name = SwapExtension(pkg.SanitizeFilename(header.Filename), ext)
	}

	fileURL, err := h.writeUpload(name, data)
	if err != nil {
		return uploadResult{}, err
	}
	result := uploadResult{URL: fileURL}
	if animated != nil {
		animatedName := "avatar.gif"
		if kind == kindBanner {
			animatedName = "banner.gif"
		}
		animatedURL, err := h.writeUpload(animatedName, animated)
		if err != nil {
			h.deleteOldFile(&fileURL)
			return uploadResult{}, err
		}
		result.AnimatedURL = &animatedURL
	}
	return result, nil
}

// imagePipelineError maps an image-pipeline failure to the response error:
// the budget / format sentinels keep their own message as a 400,
// ErrImageBusy passes through for writeUploadError's 503, and anything
// else (undecodable or unsupported bytes) is the generic 400.
func imagePipelineError(err error) error {
	switch {
	case errors.Is(err, ErrImageBusy):
		return err
	case errors.Is(err, ErrImageTooLarge),
		errors.Is(err, ErrTooManyFrames),
		errors.Is(err, ErrAnimatedWebPUnsupported),
		errors.Is(err, ErrAnimatedTooLarge):
		return fmt.Errorf("%w: %v", pkg.ErrBadRequest, err)
	default:
		return fmt.Errorf("%w: only image files are allowed (jpeg, png, gif, webp)", pkg.ErrBadRequest)
	}
}

// writeUpload stores data under "<16 random hex>_<name>" in the upload
// directory and returns its /api/uploads URL. Every call gets a fresh
// random prefix, so URLs are unique per upload.
func (h *AvatarHandler) writeUpload(name string, data []byte) (string, error) {
	randomBytes := make([]byte, 8)
	if _, err := rand.Read(randomBytes); err != nil {
		return "", fmt.Errorf("failed to generate random filename: %w", err)
	}
	diskFilename := hex.EncodeToString(randomBytes) + "_" + name

	destPath, err := pkg.SafeJoin(h.uploadDir, diskFilename)
	if err != nil {
		return "", fmt.Errorf("%w: invalid upload destination", pkg.ErrBadRequest)
	}
	if err := os.WriteFile(destPath, data, 0o600); err != nil { // #nosec G304,G703 -- verified by SafeJoin (pkg/safepath.go: rejects .., absolute paths, and any resolved path outside baseDir)
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
