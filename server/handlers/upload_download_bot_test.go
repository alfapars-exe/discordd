package handlers

import (
	"bytes"
	"context"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/testutil"
)

type botDownloadValidatorFunc func(context.Context, string) (string, error)

func (f botDownloadValidatorFunc) ValidateBotToken(ctx context.Context, token string) (string, error) {
	return f(ctx, token)
}

func TestBotDownloadBearerIdentityUsesExistingFileAuthorization(t *testing.T) {
	base, _, _ := newServeWorld(t)
	botIDs := map[string]string{
		"hb_dm_member":      serveDMUser1ID,
		"hb_channel_member": serveChannelMemberID,
		"hb_outsider":       serveOutsiderID,
	}
	validator := botDownloadValidatorFunc(func(_ context.Context, token string) (string, error) {
		if id, ok := botIDs[token]; ok {
			return id, nil
		}
		return "", services.ErrBotTokenInvalid
	})
	h := NewUploadDownloadHandler(base.uploadDir, base.mediaAuth, base.tokenValidator, validator)
	for _, tc := range []struct {
		name, token, file string
		status            int
	}{
		{"DM participant", "hb_dm_member", serveDMFile, http.StatusOK},
		{"another DM participant's file", "hb_outsider", serveDMFile, http.StatusForbidden},
		{"channel reader", "hb_channel_member", serveChannelFile, http.StatusOK},
		{"DM membership does not confer channel permission", "hb_dm_member", serveChannelFile, http.StatusForbidden},
		{"channel membership does not confer DM permission", "hb_channel_member", serveDMFile, http.StatusForbidden},
		{"invalid credential", "hb_revoked", serveDMFile, http.StatusUnauthorized},
		{"unknown disk file remains private", "hb_dm_member", serveUnclaimedFile, http.StatusNotFound},
		{"public asset remains public", "hb_outsider", servePublicFile, http.StatusOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/uploads/"+tc.file, nil)
			req.Header.Set("Authorization", "Bearer "+tc.token)
			rec := httptest.NewRecorder()
			h.Serve(rec, req)
			if rec.Code != tc.status {
				t.Fatalf("status=%d want=%d", rec.Code, tc.status)
			}
			if rec.Code == http.StatusOK && rec.Body.String() != "bytes-of-"+tc.file {
				t.Fatal("authorized download changed file bytes")
			}
			if rec.Code != http.StatusOK && bytes.Contains(rec.Body.Bytes(), []byte("bytes-of-")) {
				t.Fatal("denial leaked private bytes")
			}
		})
	}
}

func TestBotDownloadCredentialCannotBorrowHumanCookie(t *testing.T) {
	base, _, _ := newServeWorld(t)
	calls := 0
	h := NewUploadDownloadHandler(base.uploadDir, base.mediaAuth, base.tokenValidator,
		botDownloadValidatorFunc(func(context.Context, string) (string, error) {
			calls++
			return "", services.ErrBotTokenInvalid
		}))
	req := httptest.NewRequest(http.MethodGet, "/api/uploads/"+serveDMFile, nil)
	req.Header.Set("Authorization", "Bearer hb_invalid")
	req.AddCookie(&http.Cookie{Name: mediaCookieName, Value: signUploadTestToken(t, serveDMUser1ID, models.TokenScopeMedia, time.Hour)})
	rec := httptest.NewRecorder()
	h.Serve(rec, req)
	if rec.Code != http.StatusUnauthorized || calls != 1 {
		t.Fatalf("invalid bot header borrowed cookie: status=%d calls=%d", rec.Code, calls)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/uploads/"+serveDMFile, nil)
	req.AddCookie(&http.Cookie{Name: mediaCookieName, Value: "hb_cookie_must_not_authenticate"})
	if id, ok := h.authUserID(req); ok || id != "" || calls != 1 {
		t.Fatal("bot credential was accepted from a browser cookie")
	}

	req.Header.Set("Authorization", "Bearer hb_not_configured")
	if id, ok := base.authUserID(req); ok || id != "" {
		t.Fatal("handler without a bot validator accepted a bot credential")
	}
}

type botDownloadGroupRepo struct{ allowed string }

func (*botDownloadGroupRepo) GetAttachmentByFileURL(_ context.Context, url string) (*models.GroupDMAttachment, error) {
	if url != "/api/uploads/group.bin" {
		return nil, pkg.ErrNotFound
	}
	return &models.GroupDMAttachment{GroupMessageID: "group-message", FileURL: url}, nil
}
func (*botDownloadGroupRepo) GetMessageByID(context.Context, string) (*models.GroupDMMessage, error) {
	return &models.GroupDMMessage{ID: "group-message", GroupID: "group"}, nil
}
func (r *botDownloadGroupRepo) IsMember(_ context.Context, _, user string) (bool, error) {
	return r.allowed != "" && user == r.allowed, nil
}

func TestBotDownloadGroupMembershipAndOpaqueRanges(t *testing.T) {
	dir := t.TempDir()
	ciphertext := []byte{0, 255, 17, 64, 18, 7, 128, 9}
	if err := os.WriteFile(filepath.Join(dir, "group.bin"), ciphertext, 0o600); err != nil {
		t.Fatal(err)
	}
	group := &botDownloadGroupRepo{allowed: "bot-member"}
	media := services.NewMediaAccessService(
		&serveAttachmentRepo{MockAttachmentRepo: &testutil.MockAttachmentRepo{}}, &testutil.MockMessageRepo{},
		&serveDMRepo{MockDMRepo: &testutil.MockDMRepo{}}, &testutil.MockChannelPermResolver{},
		&serveReportRepo{}, &serveFeedbackRepo{}, &serveUserRepo{}, &serveMediaAssetRepo{}, group,
	)
	h := NewUploadDownloadHandler(dir, media, newUploadTestAuthService(), botDownloadValidatorFunc(func(_ context.Context, token string) (string, error) {
		if token == "hb_member" {
			return "bot-member", nil
		}
		return "bot-outsider", nil
	}))
	download := func(token, rangeHeader string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/api/uploads/group.bin", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		if rangeHeader != "" {
			req.Header.Set("Range", rangeHeader)
		}
		rec := httptest.NewRecorder()
		h.Serve(rec, req)
		return rec
	}
	full := download("hb_member", "")
	if full.Code != http.StatusOK || !bytes.Equal(full.Body.Bytes(), ciphertext) {
		t.Fatal("opaque group attachment download changed ciphertext")
	}
	partial := download("hb_member", "bytes=2-4")
	if partial.Code != http.StatusPartialContent || !bytes.Equal(partial.Body.Bytes(), ciphertext[2:5]) {
		t.Fatal("range download changed opaque ciphertext or status")
	}
	if download("hb_outsider", "").Code != http.StatusForbidden {
		t.Fatal("group outsider could download private ciphertext")
	}
	group.allowed = ""
	if download("hb_member", "").Code != http.StatusForbidden {
		t.Fatal("removed group member retained download access")
	}
}

func TestBotDownloadRealResolverRejectsRetiredCredentials(t *testing.T) {
	migrations, err := fs.Sub(database.EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatal(err)
	}
	db, err := database.New(filepath.Join(t.TempDir(), "media-bot.db"), migrations)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	ctx := context.Background()
	if _, err := db.Conn.ExecContext(ctx, `INSERT INTO users(id,username,password_hash) VALUES('media-owner','mediaowner','x')`); err != nil {
		t.Fatal(err)
	}
	bots := services.NewBotService(repository.NewBotRepository(db.Conn))
	bot, token, err := bots.CreateBot(ctx, "media-owner", models.CreateBotRequest{Username: "mediabot", DisplayName: "Media bot"})
	if err != nil {
		t.Fatal(err)
	}
	h := NewUploadDownloadHandler(t.TempDir(), nil, newUploadTestAuthService(), bots)
	req := httptest.NewRequest(http.MethodGet, "/api/uploads/private.bin", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	assertIdentity := func(t *testing.T, request *http.Request, expectedID string, want bool) {
		t.Helper()
		id, ok := h.authUserID(request)
		if ok != want || (want && id != expectedID) || (!want && id != "") {
			t.Fatal("real bot credential validation returned unexpected authentication result")
		}
	}
	assertIdentity(t, req, bot.ID, true)
	for _, tc := range []struct{ name, disable string }{
		{"banned", `UPDATE users SET is_platform_banned=1 WHERE id=?`},
		{"deleted", `UPDATE users SET deleted_at=1 WHERE id=?`},
		{"disabled", `INSERT INTO account_lifecycle(user_id,disabled_at) VALUES(?,1)`},
		{"nonbot", `UPDATE users SET is_bot=0 WHERE id=?`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			retired, retiredToken, err := bots.CreateBot(ctx, "media-owner", models.CreateBotRequest{Username: "mediabot_" + tc.name, DisplayName: "Media bot"})
			if err != nil {
				t.Fatal(err)
			}
			retiredRequest := httptest.NewRequest(http.MethodGet, "/api/uploads/private.bin", nil)
			retiredRequest.Header.Set("Authorization", "Bearer "+retiredToken)
			assertIdentity(t, retiredRequest, retired.ID, true)
			if _, err := db.Conn.ExecContext(ctx, tc.disable, retired.ID); err != nil {
				t.Fatal(err)
			}
			assertIdentity(t, retiredRequest, retired.ID, false)
		})
	}
	if err := bots.RevokeAllTokens(ctx, "media-owner", bot.ID); err != nil {
		t.Fatal(err)
	}
	assertIdentity(t, req, bot.ID, false)
}
