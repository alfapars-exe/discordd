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
// UploadDownloadHandler closes that hole:
//  1. Requires the standard auth middleware (Bearer access token).
//  2. For requests that match a channel attachment, verifies the user
//     has read access to the channel via ChannelPermResolver.
//  3. For requests that match a DM attachment, verifies the user is one
//     of the two participants in the DM channel.
//  4. For requests that don't match either (avatars, server icons, badge
//     icons, soundboard sounds, feedback/report screenshots), serves to
//     any authenticated user — these resources are intentionally
//     visible to all members and there's no per-resource scoping table
//     to consult.
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

type UploadDownloadHandler struct {
	uploadDir      string
	attachmentRepo repository.AttachmentRepository
	dmRepo         repository.DMRepository
	messageRepo    repository.MessageRepository
	permResolver   services.ChannelPermResolver
}

func NewUploadDownloadHandler(
	uploadDir string,
	attachmentRepo repository.AttachmentRepository,
	dmRepo repository.DMRepository,
	messageRepo repository.MessageRepository,
	permResolver services.ChannelPermResolver,
) *UploadDownloadHandler {
	return &UploadDownloadHandler{
		uploadDir:      uploadDir,
		attachmentRepo: attachmentRepo,
		dmRepo:         dmRepo,
		messageRepo:    messageRepo,
		permResolver:   permResolver,
	}
}

// PublicDownload serves whitelisted upload subpaths without auth.
//
// Categories that need to load via `<img src="...">` (avatars, server
// icons, badges, soundboard sounds, landing/branding) can't carry a
// Bearer header — the browser refuses to set custom headers on a
// native img request, and we deliberately don't put the access token
// in a cookie any more (C3). Auth-gating these categories means every
// rendered avatar 401s and the user sees initials placeholders forever.
//
// The whitelist lives in init_routes.go (only specific prefixes are
// routed here); this handler just performs the SafeJoin + serve. The
// route patterns prevent traversal at the mux level; serveFile
// re-validates with path.Clean + SafeJoin as defense-in-depth.
//
// Real per-channel/per-DM attachments still go through Download and
// require auth — that's where the security-meaningful check is.
func (h *UploadDownloadHandler) PublicDownload(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/api/uploads/")
	if name == "" || strings.Contains(name, "..") || strings.Contains(name, "\\") {
		http.NotFound(w, r)
		return
	}
	h.serveFile(w, r, name)
}

// Download serves a file from uploadDir after verifying the requester has
// access. Paths are resolved as `uploadDir + <name>` where <name> may
// contain one level of subdirectory (e.g. "soundboard/foo.wav"). Path
// traversal is blocked at the handler boundary AND again by
// filepath.Clean + prefix verification before any file open.
func (h *UploadDownloadHandler) Download(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	// Path comes in as "/api/uploads/<name>". Strip the prefix and reject
	// traversal markers up front; the per-file ServeFile call below
	// further verifies containment inside uploadDir.
	name := strings.TrimPrefix(r.URL.Path, "/api/uploads/")
	if name == "" || strings.Contains(name, "..") || strings.Contains(name, "\\") {
		http.NotFound(w, r)
		return
	}

	fileURL := "/api/uploads/" + name

	// Channel-attachment lookup. file_url is the unique disk URL we
	// generated when the upload was saved, so the EQ lookup either hits
	// at most one row or misses entirely.
	if att, err := h.attachmentRepo.GetByFileURL(r.Context(), fileURL); err == nil {
		msg, err := h.messageRepo.GetByID(r.Context(), att.MessageID)
		if err != nil {
			// Attachment row points to a deleted message — treat as 404
			// rather than 403 so we don't disclose the orphan.
			http.NotFound(w, r)
			return
		}
		perms, err := h.permResolver.ResolveChannelPermissions(r.Context(), user.ID, msg.ChannelID)
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
		if dmChan.User1ID != user.ID && dmChan.User2ID != user.ID {
			pkg.ErrorWithMessage(w, http.StatusForbidden, "not a participant of this DM")
			return
		}
		h.serveFile(w, r, name)
		return
	} else if !errors.Is(err, pkg.ErrNotFound) {
		pkg.ErrorWithMessage(w, http.StatusInternalServerError, "dm attachment lookup failed")
		return
	}

	// Neither attachment table claims this path — it's an avatar, server
	// icon, badge icon, soundboard sample, or similar. Those are
	// intentionally visible to every authenticated user (they're already
	// rendered to all viewers of the entity), so auth-only is sufficient.
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
