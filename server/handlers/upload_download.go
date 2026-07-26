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
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
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
	mediaAuth      services.MediaAccessService
	tokenValidator AccessTokenValidator
}

func NewUploadDownloadHandler(
	uploadDir string,
	mediaAuth services.MediaAccessService,
	tokenValidator AccessTokenValidator,
) *UploadDownloadHandler {
	return &UploadDownloadHandler{
		uploadDir:      uploadDir,
		mediaAuth:      mediaAuth,
		tokenValidator: tokenValidator,
	}
}

// authUserID extracts an authenticated user ID from either the Authorization
// Bearer header (API clients) or the hichat_media cookie (browser <img>/<video>
// tags, which can't set headers). Returns ("", false) when neither yields a
// usable token.
//
// Accepted scopes — this endpoint is the ONLY one that takes a scoped token:
//
//   - models.TokenScopeMedia — what setMediaCookie writes today.
//   - "" (unscoped) — two callers. API clients presenting a real access token
//     in the Authorization header, and browsers still holding a media cookie
//     minted before the scope claim existed. That second case is why empty is
//     allowed rather than required-to-be-media: on the deploy that ships this,
//     every logged-in browser is carrying an old cookie, and rejecting those
//     would break attachments for every open session until the user logged in
//     again. They age out on their own as clients refresh (the cookie is
//     re-set on every login/register/refresh) and this allowance can be
//     dropped once the old 30-day cookies have all expired.
//
// Anything else is refused: a token bearing a scope this build doesn't
// recognise fails closed rather than being waved through.
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
	if claims.Scope != "" && claims.Scope != models.TokenScopeMedia {
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

	// The authorization decision (attachment -> channel permission, DM ->
	// participant, else public) lives in MediaAccessService. Auth is resolved
	// lazily — the service only calls it when fileURL is an access-controlled
	// attachment, so public assets still load without touching the token.
	decision, err := h.mediaAuth.Authorize(r.Context(), fileURL, func() (string, bool) {
		return h.authUserID(r)
	})
	if err != nil {
		pkg.ErrorCtx(r.Context(), w, http.StatusInternalServerError, "media access lookup failed", err)
		return
	}

	switch decision {
	case services.MediaRequiresAuth:
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "authentication required")
	case services.MediaForbidden:
		pkg.ErrorWithMessage(w, http.StatusForbidden, "no access to this resource")
	case services.MediaNotFound:
		http.NotFound(w, r)
	case services.MediaPublic, services.MediaAllowed:
		h.serveFile(w, r, name)
	default:
		// Unreachable — every MediaDecision is handled above. Fail closed.
		http.NotFound(w, r)
	}
}

// inlineMimes are the only sniffed types the browser may render INLINE from
// the app origin. Everything else — text/html, image/svg+xml (sniffs as
// text/xml), text/javascript, fonts, wasm, unknown blobs — is served as
// application/octet-stream with Content-Disposition: attachment, because
// with all file types uploadable, rendering active content inline from
// this origin would be stored XSS (the SPA and its tokens live here).
var inlineMimes = map[string]bool{
	"image/jpeg":      true,
	"image/png":       true,
	"image/gif":       true,
	"image/webp":      true,
	"image/bmp":       true,
	"image/avif":      true,
	"image/x-icon":    true,
	"video/mp4":       true,
	"video/webm":      true,
	"audio/mpeg":      true,
	"audio/ogg":       true,
	"application/ogg": true,
	"audio/wave":      true,
	"application/pdf": true,
}

// diskPrefixRe matches the random hex prefix the upload services prepend to
// every stored file ("{16 hex}_{original name}").
var diskPrefixRe = regexp.MustCompile(`^[0-9a-f]{16}_`)

// downloadName recovers a user-facing filename from the on-disk name by
// stripping the random prefix. The disk name embeds the sanitized original
// filename, so no DB lookup is needed here.
func downloadName(name string) string {
	base := diskPrefixRe.ReplaceAllString(path.Base(name), "")
	if base == "" || base == "." {
		return "download"
	}
	return base
}

// rfc5987Encode percent-encodes everything outside RFC 5987 attr-char for
// the Content-Disposition filename* parameter.
func rfc5987Encode(s string) string {
	const hexDigits = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		isAttrChar := (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
			(c >= '0' && c <= '9') || strings.IndexByte("!#$&+-.^_`|~", c) >= 0
		if isAttrChar {
			b.WriteByte(c)
		} else {
			b.WriteByte('%')
			b.WriteByte(hexDigits[c>>4])
			b.WriteByte(hexDigits[c&0xf])
		}
	}
	return b.String()
}

// contentDisposition builds an RFC 6266 dual-form header value: an ASCII
// fallback (filename="...", quotes/backslashes escaped, non-ASCII replaced)
// plus the RFC 5987 extended form (filename*=UTF-8''...) for the real
// unicode name. Control characters are stripped first — the filename is
// user-supplied, and a raw CR/LF here would be header injection.
func contentDisposition(disp, filename string) string {
	clean := strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, filename)
	if clean == "" {
		clean = "download"
	}

	var ascii strings.Builder
	for _, r := range clean {
		switch {
		case r == '"' || r == '\\':
			ascii.WriteByte('\\')
			ascii.WriteRune(r)
		case r > 0x7e:
			ascii.WriteByte('_')
		default:
			ascii.WriteRune(r)
		}
	}

	return disp + `; filename="` + ascii.String() + `"; filename*=UTF-8''` + rfc5987Encode(clean)
}

// serveFile resolves <name> against uploadDir and writes the file to
// the response. filepath.Clean + the SafeJoin check together prevent
// path traversal even if a malicious name slipped past the prefix-level
// check above.
//
// Serving is hardened for the all-file-types era: the response Content-Type
// comes from re-sniffing the BYTES on disk (never the recorded MimeType or
// the extension), and only types in inlineMimes may render inline. The
// global securityHeaders middleware supplies nosniff + the app CSP, but the
// app CSP alone would still let an uploaded .html reference an uploaded .js
// (both same-origin) — the octet-stream + attachment + sandbox trio below
// is what actually breaks that stored-XSS chain.
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

	f, err := os.Open(full) // #nosec G304 — path containment verified by SafeJoin
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()

	fi, err := f.Stat()
	if err != nil || fi.IsDir() {
		http.NotFound(w, r)
		return
	}

	buf := make([]byte, pkg.SniffBufferSize)
	n, readErr := io.ReadFull(f, buf)
	if readErr != nil && readErr != io.ErrUnexpectedEOF && readErr != io.EOF {
		pkg.ErrorCtx(r.Context(), w, http.StatusInternalServerError, "failed to read file", readErr)
		return
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		pkg.ErrorCtx(r.Context(), w, http.StatusInternalServerError, "failed to rewind file", err)
		return
	}
	mime := pkg.RefineMIME(pkg.NormalizeMIME(http.DetectContentType(buf[:n])), name)

	// `private` is load-bearing: the paths above decide per-user whether the
	// caller may see these bytes, so a SHARED cache (corporate proxy, CDN)
	// must never store a response and replay it to a different requester —
	// that would hand one user's attachment to the next person who asks for
	// the URL, bypassing the permission check entirely. The browser's own
	// per-profile cache is safe and desirable: without it every re-render of
	// a channel refetches every image.
	w.Header().Set("Cache-Control", "private, max-age=3600")
	// Explicit (also set globally): the Content-Type below is a security
	// decision and the browser must not second-guess it.
	w.Header().Set("X-Content-Type-Options", "nosniff")

	fname := downloadName(name)
	if inlineMimes[mime] {
		w.Header().Set("Content-Type", mime)
		w.Header().Set("Content-Disposition", contentDisposition("inline", fname))
	} else {
		// Content-Type MUST be set before ServeContent, or net/http would
		// re-derive one from the extension/bytes and undo this decision.
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", contentDisposition("attachment", fname))
		// Belt and braces: even if some viewer renders the download in
		// place, it runs with no scripts, no origin, no form submission.
		// Set() replaces the app CSP on this response only — nothing
		// renders on a forced download, so nothing needs the app policy.
		w.Header().Set("Content-Security-Policy", "sandbox")
	}

	// Empty name: ServeContent must not consult the extension for a
	// Content-Type (we just set it). Range and If-Modified-Since handling
	// are preserved.
	http.ServeContent(w, r, "", fi.ModTime(), f)
}
