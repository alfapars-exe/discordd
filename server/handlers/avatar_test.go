// AvatarHandler avatar / banner endpoints through the REAL
// services.MemberService over a stateful testutil user repo, writing real
// files into a temp upload dir — so the on-disk bytes, the URLs in the
// response and the old-file cleanup are asserted end-to-end.
package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/gif"
	"math/rand/v2"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/testutil"
)

// decodeEnvelope unmarshals the pkg.JSON envelope's "data" into dst.
func decodeEnvelope(t *testing.T, rec *httptest.ResponseRecorder, dst any) {
	t.Helper()
	var env struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode envelope: %v (body %q)", err, rec.Body.String())
	}
	if err := json.Unmarshal(env.Data, dst); err != nil {
		t.Fatalf("decode data: %v (body %q)", err, rec.Body.String())
	}
}

type avatarFixture struct {
	dir  string
	h    *AvatarHandler
	mu   sync.Mutex
	user models.User
}

func newAvatarFixture(t *testing.T) *avatarFixture {
	t.Helper()
	f := &avatarFixture{dir: t.TempDir(), user: models.User{ID: "user-1", Username: "tester"}}
	users := &testutil.MockUserRepo{
		GetByIDFn: func(_ context.Context, _ string) (*models.User, error) {
			f.mu.Lock()
			defer f.mu.Unlock()
			cp := f.user
			return &cp, nil
		},
		UpdateFn: func(_ context.Context, u *models.User) error {
			f.mu.Lock()
			defer f.mu.Unlock()
			f.user = *u
			return nil
		},
	}
	svc := services.NewMemberService(users, nil, nil, nil, &testutil.MockServerRepo{},
		&testutil.MockEventPublisher{}, nil, nil)
	f.h = NewAvatarHandler(users, svc, nil, f.dir, nil)
	return f
}

func multipartRequest(t *testing.T, method, target, filename string, data []byte) *http.Request {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, err := mw.CreateFormFile("file", filename)
	if err != nil {
		t.Fatalf("create form file: %v", err)
	}
	if _, err := fw.Write(data); err != nil {
		t.Fatalf("write form file: %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close multipart: %v", err)
	}
	req := httptest.NewRequest(method, target, &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	return asTester(req)
}

// asTester attaches the fixture's caller (bot_test.go's withUser helper).
func asTester(req *http.Request) *http.Request {
	return withUser(req, &models.User{ID: "user-1", Username: "tester"})
}

// diskBytes reads the file behind an /api/uploads URL.
func (f *avatarFixture) diskBytes(t *testing.T, url *string) []byte {
	t.Helper()
	if url == nil {
		t.Fatal("URL is nil")
	}
	data, err := os.ReadFile(filepath.Join(f.dir, filepath.Base(*url)))
	if err != nil {
		t.Fatalf("read %s: %v", *url, err)
	}
	return data
}

func (f *avatarFixture) exists(url *string) bool {
	_, err := os.Stat(filepath.Join(f.dir, filepath.Base(*url)))
	return err == nil
}

// noisyPNG is a w×h opaque PNG of random pixels — far larger than the
// 512-byte sniff window, so a truncated write would fail to decode.
func noisyPNG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	r := rand.New(rand.NewPCG(1, 2))
	for i := range img.Pix {
		img.Pix[i] = uint8(r.UintN(256))
		if i%4 == 3 {
			img.Pix[i] = 0xff
		}
	}
	return encodePNGFixture(t, img)
}

func TestUploadUserAvatar_AnimatedThenStatic(t *testing.T) {
	f := newAvatarFixture(t)

	// (a) 2-frame GIF → static poster + animated GIF.
	rec := httptest.NewRecorder()
	f.h.UploadUserAvatar(rec, multipartRequest(t, http.MethodPost, "/api/users/me/avatar", "me.gif",
		buildTestGIF(t, 2, 200, 160, false, []int{7, 9}, 0)))
	if rec.Code != http.StatusOK {
		t.Fatalf("animated upload status = %d (body %q)", rec.Code, rec.Body.String())
	}
	var m1 models.MemberWithRoles
	decodeEnvelope(t, rec, &m1)
	if m1.AvatarURL == nil || m1.AvatarAnimatedURL == nil {
		t.Fatalf("avatar_url=%v avatar_animated_url=%v, want both set", m1.AvatarURL, m1.AvatarAnimatedURL)
	}
	if !strings.HasSuffix(*m1.AvatarAnimatedURL, "_avatar.gif") {
		t.Errorf("animated URL = %q, want <hex>_avatar.gif", *m1.AvatarAnimatedURL)
	}
	animated := f.diskBytes(t, m1.AvatarAnimatedURL)
	if ct := http.DetectContentType(animated); ct != "image/gif" {
		t.Errorf("animated file sniffs as %q, want image/gif", ct)
	}
	if g, err := gif.DecodeAll(bytes.NewReader(animated)); err != nil || len(g.Image) != 2 {
		t.Errorf("animated file: frames=%v err=%v", g, err)
	}
	poster := f.diskBytes(t, m1.AvatarURL)
	if ct := http.DetectContentType(poster); ct != "image/png" && ct != "image/jpeg" {
		t.Errorf("poster sniffs as %q, want png/jpeg", ct)
	}

	// (b)+(e) static PNG larger than 512 bytes → animated URL cleared, old
	// files deleted, new file byte-complete (decodes at the expected size).
	src := noisyPNG(t, 300, 300)
	if len(src) <= 512 {
		t.Fatalf("fixture too small (%d bytes) to cover the sniff window", len(src))
	}
	rec = httptest.NewRecorder()
	f.h.UploadUserAvatar(rec, multipartRequest(t, http.MethodPost, "/api/users/me/avatar", "me.png", src))
	if rec.Code != http.StatusOK {
		t.Fatalf("static upload status = %d (body %q)", rec.Code, rec.Body.String())
	}
	var m2 models.MemberWithRoles
	decodeEnvelope(t, rec, &m2)
	if m2.AvatarAnimatedURL != nil {
		t.Errorf("avatar_animated_url = %q after a static upload, want null", *m2.AvatarAnimatedURL)
	}
	if m2.AvatarURL == nil || !strings.HasSuffix(*m2.AvatarURL, "_avatar.jpg") {
		t.Errorf("avatar_url = %v, want <hex>_avatar.jpg", m2.AvatarURL)
	}
	img, _, err := image.Decode(bytes.NewReader(f.diskBytes(t, m2.AvatarURL)))
	if err != nil {
		t.Fatalf("static avatar on disk does not decode: %v", err)
	}
	if b := img.Bounds(); b.Dx() != avatarMaxDim || b.Dy() != avatarMaxDim {
		t.Errorf("static avatar dims = %v, want 256x256", b)
	}
	if f.exists(m1.AvatarURL) || f.exists(m1.AvatarAnimatedURL) {
		t.Error("previous poster / animated files were not deleted")
	}
	if f.user.AvatarAnimatedURL != nil {
		t.Error("stored row still has avatar_animated_url")
	}
}

func TestUploadUserAvatar_AnimatedWebPRejected(t *testing.T) {
	f := newAvatarFixture(t)
	rec := httptest.NewRecorder()
	f.h.UploadUserAvatar(rec, multipartRequest(t, http.MethodPost, "/api/users/me/avatar", "a.webp",
		animatedWebPHeader(0x02)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "animated WebP is not supported") {
		t.Errorf("body = %q, want the animated WebP message", rec.Body.String())
	}
	entries, _ := os.ReadDir(f.dir)
	if len(entries) != 0 {
		t.Errorf("rejected upload left %d file(s) on disk", len(entries))
	}
}

func TestUploadUserAvatar_BusyIs503(t *testing.T) {
	f := newAvatarFixture(t)
	holdAnimatedSlot(t)
	req := multipartRequest(t, http.MethodPost, "/api/users/me/avatar", "me.gif",
		buildTestGIF(t, 2, 32, 32, false, nil, 0))
	ctx, cancel := context.WithTimeout(req.Context(), 100*time.Millisecond)
	defer cancel()
	rec := httptest.NewRecorder()
	f.h.UploadUserAvatar(rec, req.WithContext(ctx))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 (body %q)", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get(retryAfterHeader); got != imageBusyRetryAfter {
		t.Errorf("Retry-After = %q, want %q", got, imageBusyRetryAfter)
	}
}

func TestUploadAndDeleteUserBanner(t *testing.T) {
	f := newAvatarFixture(t)

	upload := func() models.MemberWithRoles {
		t.Helper()
		rec := httptest.NewRecorder()
		f.h.UploadUserBanner(rec, multipartRequest(t, http.MethodPost, "/api/users/me/banner", "b.png",
			encodePNGFixture(t, newSolidRGBA(2000, 1000, color.RGBA{200, 100, 50, 0xff}))))
		if rec.Code != http.StatusOK {
			t.Fatalf("banner upload status = %d (body %q)", rec.Code, rec.Body.String())
		}
		var m models.MemberWithRoles
		decodeEnvelope(t, rec, &m)
		return m
	}

	m1 := upload()
	if m1.BannerURL == nil || !strings.HasSuffix(*m1.BannerURL, "_banner.jpg") {
		t.Fatalf("banner_url = %v, want <hex>_banner.jpg", m1.BannerURL)
	}
	img, _, err := image.Decode(bytes.NewReader(f.diskBytes(t, m1.BannerURL)))
	if err != nil {
		t.Fatalf("banner on disk does not decode: %v", err)
	}
	b := img.Bounds()
	if b.Dx() > 1200 || b.Dy() > 480 || b.Dx()*2 != b.Dy()*5 {
		t.Errorf("banner dims = %v, want ≤1200x480 at 5:2", b)
	}

	// Replacing the banner deletes the previous file.
	m2 := upload()
	if f.exists(m1.BannerURL) {
		t.Error("previous banner file not deleted on replace")
	}

	rec := httptest.NewRecorder()
	f.h.DeleteUserBanner(rec, asTester(httptest.NewRequest(http.MethodDelete, "/api/users/me/banner", nil)))
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status = %d (body %q)", rec.Code, rec.Body.String())
	}
	var m3 models.MemberWithRoles
	decodeEnvelope(t, rec, &m3)
	if m3.BannerURL != nil {
		t.Errorf("banner_url = %q after delete, want null", *m3.BannerURL)
	}
	if f.exists(m2.BannerURL) {
		t.Error("banner file not deleted")
	}
}
