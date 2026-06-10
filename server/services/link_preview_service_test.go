// Link preview tests — locks in the YouTube oEmbed fix (QA 2026-05-28 #2:
// youtube.com links 502'd because the OG scraper got consent-walled HTML and
// the failure was negative-cached for 24h) plus the generic OG parser rules.
package services

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
)

// lpMockRepo — in-file LinkPreviewRepository mock (kept out of testutil on
// purpose; only these tests need it).
type lpMockRepo struct {
	getByURLFn func(ctx context.Context, url string) (*models.LinkPreview, error)
	upserted   []*models.LinkPreview
}

func (m *lpMockRepo) GetByURL(ctx context.Context, url string) (*models.LinkPreview, error) {
	if m.getByURLFn != nil {
		return m.getByURLFn(ctx, url)
	}
	return nil, nil
}
func (m *lpMockRepo) Upsert(_ context.Context, p *models.LinkPreview) error {
	m.upserted = append(m.upserted, p)
	return nil
}
func (m *lpMockRepo) DeleteExpired(context.Context, time.Time) (int64, error) { return 0, nil }

func TestIsYouTubeHost(t *testing.T) {
	cases := []struct {
		host string
		want bool
	}{
		{"www.youtube.com", true},
		{"youtube.com", true},
		{"m.youtube.com", true},
		{"music.youtube.com", true},
		{"youtu.be", true},
		{"YOUTU.BE", true},
		{"WWW.YouTube.com", true},
		{"notyoutube.com", false},
		{"youtube.com.evil.com", false},
		{"example.com", false},
		{"yyoutube.com", false},
	}
	for _, c := range cases {
		if got := isYouTubeHost(c.host); got != c.want {
			t.Errorf("isYouTubeHost(%q) = %v, want %v", c.host, got, c.want)
		}
	}
}

func TestGetPreview_YouTubeUsesOEmbed(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.RawQuery, "url=") {
			t.Errorf("oembed request missing url param: %s", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"title":"Test Video","author_name":"Test Channel","thumbnail_url":"https://i.ytimg.com/vi/x/hq.jpg"}`))
	}))
	defer ts.Close()

	repo := &lpMockRepo{}
	svc := newLinkPreviewServiceForTest(repo, ts.Client(), ts.URL)

	p, err := svc.GetPreview(context.Background(), "https://www.youtube.com/watch?v=dQw4w9WgXcQ")
	if err != nil {
		t.Fatalf("GetPreview: %v", err)
	}
	if p.Title == nil || *p.Title != "Test Video" {
		t.Errorf("Title = %v, want Test Video", p.Title)
	}
	if p.Description == nil || *p.Description != "Test Channel" {
		t.Errorf("Description = %v, want channel name", p.Description)
	}
	if p.SiteName == nil || *p.SiteName != "YouTube" {
		t.Errorf("SiteName = %v, want YouTube", p.SiteName)
	}
	if p.ImageURL == nil || !strings.Contains(*p.ImageURL, "ytimg.com") {
		t.Errorf("ImageURL = %v, want thumbnail", p.ImageURL)
	}
	if len(repo.upserted) != 1 || repo.upserted[0].Error {
		t.Errorf("expected one successful cache upsert, got %+v", repo.upserted)
	}
}

func TestGetPreview_YouTubeOEmbedFailure_NegativeCached(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "not found", http.StatusNotFound)
	}))
	defer ts.Close()

	repo := &lpMockRepo{}
	svc := newLinkPreviewServiceForTest(repo, ts.Client(), ts.URL)

	_, err := svc.GetPreview(context.Background(), "https://youtu.be/deleted")
	if err == nil {
		t.Fatal("expected error for oembed 404")
	}
	if len(repo.upserted) != 1 || !repo.upserted[0].Error {
		t.Errorf("expected one negative-cache upsert, got %+v", repo.upserted)
	}
}

func TestGetPreview_OEmbedEmptyTitleIsError(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"title":"","author_name":"x"}`))
	}))
	defer ts.Close()

	svc := newLinkPreviewServiceForTest(&lpMockRepo{}, ts.Client(), ts.URL)
	if _, err := svc.GetPreview(context.Background(), "https://youtube.com/watch?v=x"); err == nil {
		t.Fatal("empty oembed title must surface as an error, not a half-empty preview")
	}
}

func TestGetPreview_FreshCacheHitSkipsFetch(t *testing.T) {
	title := "Cached Title"
	repo := &lpMockRepo{
		getByURLFn: func(_ context.Context, _ string) (*models.LinkPreview, error) {
			return &models.LinkPreview{
				URL:       "https://youtube.com/watch?v=x",
				Title:     &title,
				FetchedAt: time.Now().UTC().Format("2006-01-02 15:04:05"),
			}, nil
		},
	}
	// nil-safe: a cache hit must never touch the network. A panic on a nil
	// client would fail the test loudly if the cache path regressed.
	svc := newLinkPreviewServiceForTest(repo, nil, "http://never-called.invalid")

	p, err := svc.GetPreview(context.Background(), "https://youtube.com/watch?v=x")
	if err != nil {
		t.Fatalf("GetPreview: %v", err)
	}
	if p.Title == nil || *p.Title != title {
		t.Errorf("Title = %v, want cache hit %q", p.Title, title)
	}
}

func TestGetPreview_CachedFailureShortCircuits(t *testing.T) {
	repo := &lpMockRepo{
		getByURLFn: func(_ context.Context, _ string) (*models.LinkPreview, error) {
			return &models.LinkPreview{
				URL:       "https://example.com",
				Error:     true,
				FetchedAt: time.Now().UTC().Format("2006-01-02 15:04:05"),
			}, nil
		},
	}
	svc := newLinkPreviewServiceForTest(repo, nil, "http://never-called.invalid")
	if _, err := svc.GetPreview(context.Background(), "https://example.com"); err == nil {
		t.Fatal("negative-cached URL must return an error without refetching")
	}
}

// ─── Generic OG parser rules ───

func TestParseOGMetadata_Priority(t *testing.T) {
	htmlDoc := `<html><head>
		<title>HTML Title</title>
		<meta name="twitter:title" content="Twitter Title">
		<meta property="og:title" content="OG Title">
		<meta property="og:description" content="OG Desc">
		<meta property="og:site_name" content="Site">
	</head><body>ignored</body></html>`

	og := parseOGMetadata(strings.NewReader(htmlDoc))
	if og.title != "OG Title" {
		t.Errorf("title = %q, want og:title to win", og.title)
	}
	if og.description != "OG Desc" || og.siteName != "Site" {
		t.Errorf("description/siteName = %q/%q", og.description, og.siteName)
	}
}

func TestParseOGMetadata_TwitterThenTitleFallback(t *testing.T) {
	twitterOnly := `<html><head><meta name="twitter:title" content="TW"></head><body></body></html>`
	if og := parseOGMetadata(strings.NewReader(twitterOnly)); og.title != "TW" {
		t.Errorf("twitter fallback title = %q, want TW", og.title)
	}

	titleOnly := `<html><head><title>Plain</title></head><body></body></html>`
	if og := parseOGMetadata(strings.NewReader(titleOnly)); og.title != "Plain" {
		t.Errorf("html-title fallback = %q, want Plain", og.title)
	}
}

func TestParseOGMetadata_Truncation(t *testing.T) {
	long := strings.Repeat("a", 400)
	htmlDoc := `<html><head><meta property="og:title" content="` + long + `"></head><body></body></html>`
	if og := parseOGMetadata(strings.NewReader(htmlDoc)); len(og.title) != 300 {
		t.Errorf("title length = %d, want truncated to 300", len(og.title))
	}
}
