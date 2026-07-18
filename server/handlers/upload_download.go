// Package handlers — auth-gated download for files served from cfg.Upload.Dir.
//
// The previous implementation registered http.FileServer directly behind
// `/api/uploads/`, which meant every attachment was publicly downloadable
// to anyone holding the URL. Filename guessability was mitigated by an
// 8-byte random prefix, but "URL is unguessable" is not a security
// boundary — channel members copy-paste links to outsiders, browser
// history syncs cross-device, share sheets POST URLs to third parties,
// and so on. Plaintext attachments leak to anyone who ever sees the
// link; E2EE attachments are encrypted but still leak filename + size
// metadata.
//
// UploadDownloadHandler.Serve closes that hole (F-1, audit 2026-05-29):
//  1. Auth is accepted via the Authorization Bearer header (API clients) OR
//     the hichat_media HttpOnly cookie (browser <img>/<video>, which can't set
//     headers). The cookie is scoped to /api/uploads only.
//  2. For requests that match a channel attachment, verifies the user
//     has read access to the channel via ChannelPermResolver.
//  3. For requests that match a DM attachment, verifies the user is one
//     of the two participants in the DM channel.
//  4. For requests that don't match either (avatars, server icons, badge
//     icons, soundboard sounds, feedback/report screenshots), serves
//     publicly — these resources are intentionally visible to everyone who
//     can see the entity and there's no per-resource scoping table to
//     consult, so they must load in unauthenticated <img> contexts too.
package handlers

import (
	"errors"
	"net/http"
	"path"
	"path/filepath"
	"strings"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/services"
)

// mediaCookieName is the HttpOnly cookie that carries the access token for
// browser <img>/<video> requests to /api/uploads/*. A native <img> tag can't
// send an Authorization header, so without this an auth-gated attachment would
// never render. Scoped to Path=/api/uploads, HttpOnly + Secure + SameSite=None
// — the None (rather than Strict) is required so the desktop shell
// (app://hichat origin) and mobile shells (capacitor://) can still receive
// the cookie on cross-site <img> subresource loads. CSRF surface is capped
// by the GET-only + permission-checked Serve handler and unguessable URLs
// (see setMediaCookie in auth.go for the full rationale). Set on
// login/register/refresh by the auth handler.
const mediaCookieName = "hichat_media"

// AccessTokenValidator validates a JWT access token. Satisfied by
// services.AuthService; a narrow interface keeps this handler decoupled.
type AccessTokenValidator interface {
	ValidateAccessToken(tokenString string) (*models.TokenClaims, error)
}

type UploadDownloadHandler struct {
	uploadDir      string
	attachmentRepo repository.AttachmentRepository
	dmRepo         repository.DMRepository
	messageRepo    repository.MessageRepository
	permResolver   services.ChannelPermResolver
	tokenValidator AccessTokenValidator
}

func NewUploadDownloadHandler(
	uploadDir string,
	attachmentRepo repository.AttachmentRepository,
	dmRepo repository.DMRepository,
	messageRepo repository.MessageRepository,
	permResolver services.ChannelPermResolver,
	tokenValidator AccessTokenValidator,
) *UploadDownloadHandler {
	return &UploadDownloadHandler{
		uploadDir:      uploadDir,
		attachmentRepo: attachmentRepo,
		dmRepo:         dmRepo,
		messageRepo:    messageRepo,
		permResolver:   permResolver,
		tokenValidator: tokenValidator,
	}
}

// authUserID extracts an authenticated user ID from either the Authorization
// Bearer header (API clients) or the hichat_media cookie (browser <img>/<video>
// tags, which can't set headers). Returns ("", false) when neither yields a
// valid access token.
func (h *UploadDownloadHandler) authUserID(r *http.Request) (string, bool) {
	var token string
	if ah := r.Header.Get("Authorization"); strings.HasPrefix(ah, "Bearer ") {
		token = strings.TrimPrefix(ah, "Bearer ")
	} else if c, err := r.Cookie(mediaCookieName); err == nil {
		token = c.Value
	}
	if token == "" || h.tokenValidator == nil {
		return "", false
	}
	claims, err := h.tokenValidator.ValidateAccessToken(token)
	if err != nil {
		return "", false
	}
	return claims.UserID, true
}

// Serve handles GET /api/uploads/<name>.
//
// Channel and DM attachments are access-controlled (channel-read permission /
// DM participation); auth is accepted via Bearer header OR the hichat_media
// HttpOnly cookie so rendered <img>/<video> tags work without JS. Everything
// else (avatars, server icons, badge icons, soundboard samples, branding) is
// served publicly — it's already visible to everyone who can see the entity.
//
// Path traversal is blocked here (prefix reject) and again in serveFile
// (path.Clean + SafeJoin) as defense-in-depth.
func (h *UploadDownloadHandler) Serve(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/api/uploads/")
	if name == "" || strings.Contains(name, "..") || strings.Contains(name, "\\") {
		http.NotFound(w, r)
		return
	}

	fileURL := "/api/uploads/" + name

	// Channel-attachment lookup. file_url is the unique disk URL we generated
	// when the upload was saved, so the EQ lookup hits at most one row.
	if att, err := h.attachmentRepo.GetByFileURL(r.Context(), fileURL); err == nil {
		userID, ok := h.authUserID(r)
		if !ok {
			pkg.ErrorWithMessage(w, http.StatusUnauthorized, "authentication required")
			return
		}
		msg, err := h.messageRepo.GetByID(r.Context(), att.MessageID)
		if err != nil {
			// Attachment row points to a deleted message — treat as 404
			// rather than 403 so we don't disclose the orphan.
			http.NotFound(w, r)
			return
		}
		perms, err := h.permResolver.ResolveChannelPermissions(r.Context(), userID, msg.ChannelID)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		if perms&models.PermReadMessages == 0 {
			pkg.ErrorWithMessage(w, http.StatusForbidden, "no access to this channel")
			return
		}
		h.serveFile(w, r, name)
		return
	} else if !errors.Is(err, pkg.ErrNotFound) {
		pkg.ErrorWithMessage(w, http.StatusInternalServerError, "attachment lookup failed")
		return
	}

	// DM-attachment lookup.
	if dmAtt, err := h.dmRepo.GetAttachmentByFileURL(r.Context(), fileURL); err == nil {
		userID, ok := h.authUserID(r)
		if !ok {
			pkg.ErrorWithMessage(w, http.StatusUnauthorized, "authentication required")
			return
		}
		dmMsg, err := h.dmRepo.GetMessageByID(r.Context(), dmAtt.DMMessageID)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		dmChan, err := h.dmRepo.GetChannelByID(r.Context(), dmMsg.DMChannelID)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		if dmChan.User1ID != userID && dmChan.User2ID != userID {
			pkg.ErrorWithMessage(w, http.StatusForbidden, "not a participant of this DM")
			return
		}
		h.serveFile(w, r, name)
		return
	} else if !errors.Is(err, pkg.ErrNotFound) {
		pkg.ErrorWithMessage(w, http.StatusInternalServerError, "dm attachment lookup failed")
		return
	}

	// Neither attachment table claims this path — it's an avatar, server icon,
	// badge icon, soundboard sample, or branding. Intentionally public: these
	// are already rendered to every viewer of the entity and must load in
	// unauthenticated <img> contexts.
	h.serveFile(w, r, name)
}

// serveFile resolves <name> against uploadDir and writes the file to
// the response. filepath.Clean + the SafeJoin check together prevent
// path traversal even if a malicious name slipped past the prefix-level
// check above.
func (h *UploadDownloadHandler) serveFile(w http.ResponseWriter, r *http.Request, name string) {
	// path.Clean normalises any "./" or doubled slashes that the URL
	// parser might preserve. We use path.Clean (forward-slash semantics)
	// before handing to filepath which then translates to OS conventions.
	clean := path.Clean("/" + name)
	if strings.HasPrefix(clean, "/..") {
		http.NotFound(w, r)
		return
	}

	full, err := pkg.SafeJoin(h.uploadDir, strings.TrimPrefix(clean, "/"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	// Filepath separator normalisation for cross-platform safety.
	full = filepath.FromSlash(full)
	http.ServeFile(w, r, full)
}
