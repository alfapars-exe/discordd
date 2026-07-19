// Upload/download auth tests — the hichat_media cookie now carries a
// media-SCOPED token instead of the full API access token. authUserID must
// accept exactly two things: a media-scoped token (the new cookie) and an
// unscoped token (access tokens, plus media cookies already sitting in
// browsers from before this change). Anything else is refused.
package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/testutil"
	"github.com/golang-jwt/jwt/v5"
)

const testUploadJWTSecret = "test-secret-key-for-upload-download"

// newUploadTestAuthService builds the real AuthService over mock repos. Using
// the production service (rather than a fake validator) is what makes these
// tests cover the actual token-validation logic the handler relies on.
func newUploadTestAuthService() services.AuthService {
	return services.NewAuthService(
		&testutil.MockUserRepo{},
		&testutil.MockSessionRepo{},
		&testutil.MockResetRepo{},
		&testutil.MockEventPublisher{},
		&testutil.MockEmailSender{},
		testUploadJWTSecret,
		15,
		7,
	)
}

func newTestUploadHandler(uploadDir string) *UploadDownloadHandler {
	return NewUploadDownloadHandler(uploadDir, nil, nil, nil, nil, newUploadTestAuthService())
}

// signUploadTestToken mints a JWT with an explicit scope and TTL. Signing by
// hand (rather than through AuthService) is what lets these cases cover an
// already-expired cookie and a scope the server has never issued.
func signUploadTestToken(t *testing.T, userID, scope string, ttl time.Duration) string {
	t.Helper()
	now := time.Now()
	claims := &models.TokenClaims{
		UserID:   userID,
		Username: "testuser",
		Scope:    scope,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(now.Add(ttl)),
			IssuedAt:  jwt.NewNumericDate(now.Add(-time.Minute)),
			Issuer:    "mqvi",
		},
	}
	signed, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(testUploadJWTSecret))
	if err != nil {
		t.Fatalf("failed to sign test token: %v", err)
	}
	return signed
}

func TestAuthUserID_MediaCookieScopes(t *testing.T) {
	h := newTestUploadHandler(t.TempDir())

	tests := []struct {
		name       string
		scope      string
		ttl        time.Duration
		wantUserID string
		wantOK     bool
	}{
		{
			name:       "media-scoped cookie authenticates an attachment load",
			scope:      models.TokenScopeMedia,
			ttl:        7 * 24 * time.Hour,
			wantUserID: "user-1",
			wantOK:     true,
		},
		{
			name:   "expired media cookie is refused",
			scope:  models.TokenScopeMedia,
			ttl:    -time.Second,
			wantOK: false,
		},
		{
			// Cookies minted before this change hold a plain access token
			// with no scope claim. They must keep working until they age
			// out, or every browser tab open across the deploy loses its
			// images until the user re-logs in.
			name:       "legacy unscoped access-token cookie still accepted during rollout",
			scope:      "",
			ttl:        15 * time.Minute,
			wantUserID: "user-1",
			wantOK:     true,
		},
		{
			name:   "expired legacy cookie is refused",
			scope:  "",
			ttl:    -time.Second,
			wantOK: false,
		},
		{
			name:   "token with an unrecognised scope is refused",
			scope:  "some-future-scope",
			ttl:    time.Hour,
			wantOK: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/uploads/abc123.png", nil)
			req.AddCookie(&http.Cookie{
				Name:  mediaCookieName,
				Value: signUploadTestToken(t, "user-1", tc.scope, tc.ttl),
			})

			userID, ok := h.authUserID(req)
			if ok != tc.wantOK {
				t.Fatalf("authUserID ok = %v, want %v (userID %q)", ok, tc.wantOK, userID)
			}
			if userID != tc.wantUserID {
				t.Errorf("authUserID userID = %q, want %q", userID, tc.wantUserID)
			}
		})
	}
}

// TestAuthUserID_BearerHeader covers the API-client path: a normal unscoped
// access token in the Authorization header. A media-scoped token presented
// this way is refused here too — the header is not a laundering route for a
// cookie-scoped credential.
func TestAuthUserID_BearerHeader(t *testing.T) {
	h := newTestUploadHandler(t.TempDir())

	t.Run("unscoped access token accepted", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/uploads/abc123.png", nil)
		req.Header.Set("Authorization", "Bearer "+signUploadTestToken(t, "user-7", "", 15*time.Minute))
		userID, ok := h.authUserID(req)
		if !ok || userID != "user-7" {
			t.Fatalf("authUserID = (%q, %v), want (user-7, true)", userID, ok)
		}
	})

	t.Run("media-scoped token in the header is accepted for uploads only", func(t *testing.T) {
		// /api/uploads IS the media scope's intended destination, so a
		// media token works here regardless of how it arrived. The
		// restriction that matters lives in AuthMiddleware (see
		// middleware/auth_test.go), which refuses it on every other route.
		req := httptest.NewRequest(http.MethodGet, "/api/uploads/abc123.png", nil)
		req.Header.Set("Authorization", "Bearer "+signUploadTestToken(t, "user-7", models.TokenScopeMedia, time.Hour))
		userID, ok := h.authUserID(req)
		if !ok || userID != "user-7" {
			t.Fatalf("authUserID = (%q, %v), want (user-7, true)", userID, ok)
		}
	})

	t.Run("no credential at all", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/uploads/abc123.png", nil)
		if userID, ok := h.authUserID(req); ok {
			t.Fatalf("authUserID = (%q, true), want (\"\", false)", userID)
		}
	})

	t.Run("garbage token", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/uploads/abc123.png", nil)
		req.Header.Set("Authorization", "Bearer not-a-jwt")
		if userID, ok := h.authUserID(req); ok {
			t.Fatalf("authUserID = (%q, true), want (\"\", false)", userID)
		}
	})
}

// TestServeFile_CacheControlIsPrivate guards the caching header. Attachment
// responses are permission-checked per user, so a shared cache (corporate
// proxy, CDN) must never store one and hand it to the next requester — but
// the browser's own cache should keep it, otherwise every re-render refetches
// the image.
func TestServeFile_CacheControlIsPrivate(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "abc123.png"), []byte("png-bytes"), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	h := newTestUploadHandler(dir)

	req := httptest.NewRequest(http.MethodGet, "/api/uploads/abc123.png", nil)
	rec := httptest.NewRecorder()
	h.serveFile(rec, req, "abc123.png")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", rec.Code, rec.Body.String())
	}
	if got, want := rec.Header().Get("Cache-Control"), "private, max-age=3600"; got != want {
		t.Errorf("Cache-Control = %q, want %q", got, want)
	}
}

// compile-time guard: the handler's validator interface is satisfied by the
// real AuthService, so these tests exercise production validation logic.
var _ AccessTokenValidator = (services.AuthService)(nil)

// ─────────────────────────────────────────────────────────────────────────────
// Serve() — the F-1 authorization gate.
//
// Before F-1 (audit 2026-05-29) /api/uploads/ was a bare http.FileServer:
// every attachment in every private channel and every DM was downloadable by
// anyone holding the URL. Serve now routes each request through one of three
// decisions, and THAT ROUTING is what these tests pin:
//
//	channel attachment → requires PermReadMessages on the owning channel
//	DM attachment      → requires being one of the two participants
//	anything else      → public (avatars, server icons, badges, soundboard)
//
// A regression in any of the first two re-opens public access to private
// attachments, which is why this is a table over the whole matrix rather than
// a couple of happy-path cases.
// ─────────────────────────────────────────────────────────────────────────────

// Actors. Deliberately disjoint: the channel member must NOT be a DM
// participant and vice versa, so a test that passes only because the handler
// confused the two checks would fail here.
const (
	serveChannelMemberID = "user-channel-member"
	serveDMUser1ID       = "user-dm-one"
	serveDMUser2ID       = "user-dm-two"
	serveOutsiderID      = "user-outsider"
)

// Files on disk under the upload dir.
const (
	serveChannelFile = "aabbccdd-channel-secret.png"
	serveDMFile      = "eeff0011-dm-secret.png"
	servePublicFile  = "22334455-avatar.png"
)

// serveAttachmentRepo answers GetByFileURL from a fixture map and reports
// pkg.ErrNotFound for anything else — the signal Serve reads as "this path is
// not a channel attachment, fall through". testutil's mock returns (nil, nil)
// for this method, which Serve would treat as a HIT on a nil row.
type serveAttachmentRepo struct {
	*testutil.MockAttachmentRepo
	byURL map[string]*models.Attachment
}

func (s *serveAttachmentRepo) GetByFileURL(_ context.Context, fileURL string) (*models.Attachment, error) {
	if att, ok := s.byURL[fileURL]; ok {
		return att, nil
	}
	return nil, pkg.ErrNotFound
}

// serveDMRepo does the same for the DM attachment table.
type serveDMRepo struct {
	*testutil.MockDMRepo
	attByURL map[string]*models.DMAttachment
}

func (s *serveDMRepo) GetAttachmentByFileURL(_ context.Context, fileURL string) (*models.DMAttachment, error) {
	if att, ok := s.attByURL[fileURL]; ok {
		return att, nil
	}
	return nil, pkg.ErrNotFound
}

var (
	_ repository.AttachmentRepository = (*serveAttachmentRepo)(nil)
	_ repository.DMRepository         = (*serveDMRepo)(nil)
	_ repository.MessageRepository    = (*testutil.MockMessageRepo)(nil)
	_ services.ChannelPermResolver    = (*testutil.MockChannelPermResolver)(nil)
)

// newServeWorld wires a handler over a temp upload dir containing all three
// fixture files, with repos describing one channel attachment (msg-1 in
// chan-1), one DM attachment (dm-msg-1 in dm-chan-1 between serveDMUser1ID and
// serveDMUser2ID) and nothing claiming the avatar. Returns the upload dir so
// traversal tests can plant a secret next to it.
func newServeWorld(t *testing.T) (*UploadDownloadHandler, string) {
	t.Helper()

	dir := t.TempDir()
	for _, name := range []string{serveChannelFile, serveDMFile, servePublicFile} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("bytes-of-"+name), 0o600); err != nil {
			t.Fatalf("write fixture %s: %v", name, err)
		}
	}

	attachments := &serveAttachmentRepo{
		MockAttachmentRepo: &testutil.MockAttachmentRepo{},
		byURL: map[string]*models.Attachment{
			"/api/uploads/" + serveChannelFile: {
				ID:        "att-1",
				MessageID: "msg-1",
				Filename:  "channel-secret.png",
				FileURL:   "/api/uploads/" + serveChannelFile,
			},
		},
	}

	dmRepo := &serveDMRepo{
		MockDMRepo: &testutil.MockDMRepo{
			GetMessageByIDFn: func(_ context.Context, id string) (*models.DMMessage, error) {
				if id != "dm-msg-1" {
					return nil, pkg.ErrNotFound
				}
				return &models.DMMessage{ID: id, DMChannelID: "dm-chan-1", UserID: serveDMUser1ID}, nil
			},
			GetChannelByIDFn: func(_ context.Context, id string) (*models.DMChannel, error) {
				if id != "dm-chan-1" {
					return nil, pkg.ErrNotFound
				}
				return &models.DMChannel{ID: id, User1ID: serveDMUser1ID, User2ID: serveDMUser2ID}, nil
			},
		},
		attByURL: map[string]*models.DMAttachment{
			"/api/uploads/" + serveDMFile: {
				ID:          "dm-att-1",
				DMMessageID: "dm-msg-1",
				Filename:    "dm-secret.png",
				FileURL:     "/api/uploads/" + serveDMFile,
			},
		},
	}

	messages := &testutil.MockMessageRepo{
		GetByIDFn: func(_ context.Context, id string) (*models.Message, error) {
			if id != "msg-1" {
				return nil, pkg.ErrNotFound
			}
			return &models.Message{ID: id, ChannelID: "chan-1", UserID: serveChannelMemberID}, nil
		},
	}

	perms := &testutil.MockChannelPermResolver{
		ResolveChannelPermissionsFn: func(_ context.Context, userID, channelID string) (models.Permission, error) {
			if channelID == "chan-1" && userID == serveChannelMemberID {
				return models.PermReadMessages, nil
			}
			// Everyone else resolves to zero permissions rather than an
			// error: an outsider in the same server is the realistic case
			// (the channel exists for them, they just can't read it).
			return 0, nil
		},
	}

	h := NewUploadDownloadHandler(dir, attachments, dmRepo, messages, perms, newUploadTestAuthService())
	return h, dir
}

// serveAs issues GET <path> as userID ("" = no credential at all) through the
// media cookie, the same way a browser <img> tag would.
func serveAs(t *testing.T, h *UploadDownloadHandler, path, userID string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if userID != "" {
		req.AddCookie(&http.Cookie{
			Name:  mediaCookieName,
			Value: signUploadTestToken(t, userID, models.TokenScopeMedia, time.Hour),
		})
	}
	rec := httptest.NewRecorder()
	h.Serve(rec, req)
	return rec
}

func TestServe_AuthGating(t *testing.T) {
	h, _ := newServeWorld(t)

	tests := []struct {
		name       string
		path       string
		userID     string // "" = anonymous
		wantStatus int
		// wantBody, when set, must be the exact body — used on the 200s to
		// prove the file bytes actually made it out (a 200 with an empty body
		// would otherwise pass).
		wantBody string
	}{
		{
			name:       "channel attachment refused to a user without channel read permission",
			path:       "/api/uploads/" + serveChannelFile,
			userID:     serveOutsiderID,
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "channel attachment refused to a DM participant who is not in the channel",
			path:       "/api/uploads/" + serveChannelFile,
			userID:     serveDMUser1ID,
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "channel attachment served to a member with read permission",
			path:       "/api/uploads/" + serveChannelFile,
			userID:     serveChannelMemberID,
			wantStatus: http.StatusOK,
			wantBody:   "bytes-of-" + serveChannelFile,
		},
		{
			name:       "channel attachment refused outright without a credential",
			path:       "/api/uploads/" + serveChannelFile,
			userID:     "",
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "dm attachment refused to a non-participant",
			path:       "/api/uploads/" + serveDMFile,
			userID:     serveOutsiderID,
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "dm attachment refused to a channel member who is not in the DM",
			path:       "/api/uploads/" + serveDMFile,
			userID:     serveChannelMemberID,
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "dm attachment served to participant user1",
			path:       "/api/uploads/" + serveDMFile,
			userID:     serveDMUser1ID,
			wantStatus: http.StatusOK,
			wantBody:   "bytes-of-" + serveDMFile,
		},
		{
			name:       "dm attachment served to participant user2",
			path:       "/api/uploads/" + serveDMFile,
			userID:     serveDMUser2ID,
			wantStatus: http.StatusOK,
			wantBody:   "bytes-of-" + serveDMFile,
		},
		{
			name:       "dm attachment refused outright without a credential",
			path:       "/api/uploads/" + serveDMFile,
			userID:     "",
			wantStatus: http.StatusUnauthorized,
		},
		{
			// Avatars/icons/badges have no per-resource scoping table, and
			// must render in unauthenticated <img> contexts (login screen,
			// invite landing page). Public is the intended behaviour here.
			name:       "public path served with no credential at all",
			path:       "/api/uploads/" + servePublicFile,
			userID:     "",
			wantStatus: http.StatusOK,
			wantBody:   "bytes-of-" + servePublicFile,
		},
		{
			name:       "public path served to an authenticated stranger too",
			path:       "/api/uploads/" + servePublicFile,
			userID:     serveOutsiderID,
			wantStatus: http.StatusOK,
			wantBody:   "bytes-of-" + servePublicFile,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rec := serveAs(t, h, tc.path, tc.userID)
			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d (body %q)", rec.Code, tc.wantStatus, rec.Body.String())
			}
			if tc.wantBody != "" && rec.Body.String() != tc.wantBody {
				t.Errorf("body = %q, want %q", rec.Body.String(), tc.wantBody)
			}
			// A denial must never leak the bytes it just refused.
			if tc.wantStatus != http.StatusOK && strings.Contains(rec.Body.String(), "bytes-of-") {
				t.Errorf("denied response leaked file content: %q", rec.Body.String())
			}
		})
	}
}

// TestServe_RefusesPathTraversal plants a secret file one directory ABOVE the
// upload dir and confirms no spelling of ".." reaches it. Serve rejects on the
// raw name (prefix check) and serveFile rejects again after path.Clean +
// SafeJoin; both layers are exercised.
func TestServe_RefusesPathTraversal(t *testing.T) {
	h, uploadDir := newServeWorld(t)

	const secret = "TOP-SECRET-OUTSIDE-UPLOAD-DIR"
	secretPath := filepath.Join(filepath.Dir(uploadDir), "secret.txt")
	if err := os.WriteFile(secretPath, []byte(secret), 0o600); err != nil {
		t.Fatalf("write secret fixture: %v", err)
	}

	traversals := []struct {
		name string
		path string
	}{
		{"literal dot-dot", "/api/uploads/../secret.txt"},
		{"nested dot-dot", "/api/uploads/sub/../../secret.txt"},
		{"percent-encoded dots", "/api/uploads/%2e%2e/secret.txt"},
		{"percent-encoded slash", "/api/uploads/..%2fsecret.txt"},
		{"backslash separator", "/api/uploads/..%5csecret.txt"},
		{"empty name", "/api/uploads/"},
	}

	for _, tc := range traversals {
		t.Run(tc.name, func(t *testing.T) {
			// Try it authenticated — traversal must fail on the path, not
			// merely because the caller had no credential.
			rec := serveAs(t, h, tc.path, serveChannelMemberID)
			if rec.Code == http.StatusOK {
				t.Fatalf("traversal %q returned 200 (body %q)", tc.path, rec.Body.String())
			}
			if strings.Contains(rec.Body.String(), secret) {
				t.Fatalf("traversal %q leaked the out-of-tree file", tc.path)
			}
		})
	}

	// Defense-in-depth: even calling serveFile directly with a traversing
	// name (i.e. if the prefix check above were ever removed) must not read
	// outside the upload dir.
	t.Run("serveFile rejects a traversing name directly", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/uploads/x", nil)
		rec := httptest.NewRecorder()
		h.serveFile(rec, req, "../secret.txt")
		if rec.Code == http.StatusOK {
			t.Fatalf("serveFile served an out-of-tree path (body %q)", rec.Body.String())
		}
		if strings.Contains(rec.Body.String(), secret) {
			t.Fatalf("serveFile leaked the out-of-tree file")
		}
	})
}

// TestServe_OrphanAndLookupFailures covers the two non-happy repo outcomes:
// an attachment row pointing at a deleted message must 404 (not 403, which
// would confirm the file exists), and a repo error that is NOT ErrNotFound
// must surface as a 500 rather than silently falling through to the public
// branch — that fall-through would be an auth bypass.
func TestServe_OrphanAndLookupFailures(t *testing.T) {
	t.Run("attachment pointing at a deleted message is 404", func(t *testing.T) {
		h, _ := newServeWorld(t)
		// msg-2 is unknown to the message repo → GetByID returns ErrNotFound.
		att := h.attachmentRepo.(*serveAttachmentRepo)
		att.byURL["/api/uploads/"+servePublicFile] = &models.Attachment{
			ID: "att-orphan", MessageID: "msg-gone", FileURL: "/api/uploads/" + servePublicFile,
		}
		rec := serveAs(t, h, "/api/uploads/"+servePublicFile, serveChannelMemberID)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404 (body %q)", rec.Code, rec.Body.String())
		}
	})

	t.Run("attachment lookup error does not fall through to public serving", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, servePublicFile), []byte("bytes-of-"+servePublicFile), 0o600); err != nil {
			t.Fatalf("write fixture: %v", err)
		}
		boom := &boomAttachmentRepo{MockAttachmentRepo: &testutil.MockAttachmentRepo{}}
		h := NewUploadDownloadHandler(dir, boom, &serveDMRepo{MockDMRepo: &testutil.MockDMRepo{}},
			&testutil.MockMessageRepo{}, &testutil.MockChannelPermResolver{}, newUploadTestAuthService())

		rec := serveAs(t, h, "/api/uploads/"+servePublicFile, serveChannelMemberID)
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d, want 500 (body %q)", rec.Code, rec.Body.String())
		}
		if strings.Contains(rec.Body.String(), "bytes-of-") {
			t.Fatalf("lookup failure fell through and served the file: %q", rec.Body.String())
		}
	})
}

// boomAttachmentRepo fails GetByFileURL with a non-ErrNotFound error.
type boomAttachmentRepo struct {
	*testutil.MockAttachmentRepo
}

func (b *boomAttachmentRepo) GetByFileURL(_ context.Context, _ string) (*models.Attachment, error) {
	return nil, errBoomLookup
}

var errBoomLookup = errorString("database is on fire")

type errorString string

func (e errorString) Error() string { return string(e) }
