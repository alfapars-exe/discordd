// Package handlers -- GifHandler: backend proxy for Klipy GIF API.
// API key is kept server-side. Returns 503 if KLIPY_API_KEY is not set.
package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

const klipyBaseURL = "https://api.klipy.com"

// klipyHTTPClient bounds every outbound call to the Klipy API. http.Get's
// DefaultClient has no timeout, so a stalled/slow-loris response from Klipy
// would otherwise hang the request-handling goroutine indefinitely.
//
// CheckRedirect additionally pins every hop of a redirect chain to the same
// https://api.klipy.com origin the initial request is guarded to (see
// errKlipyBadURL below): the request URL embeds h.klipyAPIKey as a path
// segment, so an unconstrained redirect (open-redirect on Klipy's side, or a
// compromised/misconfigured response) could leak that key to an attacker
// host. Capped at 3 hops — Klipy's API has no legitimate reason to redirect
// more than once or twice.
var klipyHTTPClient = &http.Client{
	Timeout: 10 * time.Second,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 3 {
			return fmt.Errorf("stopped after 3 redirects")
		}
		if req.URL.Scheme != "https" || req.URL.Host != "api.klipy.com" {
			return fmt.Errorf("refusing redirect to disallowed host %q", req.URL.Host)
		}
		return nil
	},
}

// GifResult is the simplified GIF info returned to the client.
type GifResult struct {
	ID         string `json:"id"`
	Title      string `json:"title"`
	PreviewURL string `json:"preview_url"` // xs gif for picker thumbnail
	URL        string `json:"url"`         // md gif for message display
	Width      int    `json:"width"`
	Height     int    `json:"height"`
}

type GifHandler struct {
	klipyAPIKey string
}

func NewGifHandler(klipyAPIKey string) *GifHandler {
	return &GifHandler{klipyAPIKey: klipyAPIKey}
}

// Trending returns popular GIFs.
// GET /api/gifs/trending?per_page=24&page=1
func (h *GifHandler) Trending(w http.ResponseWriter, r *http.Request) {
	if h.klipyAPIKey == "" {
		pkg.ErrorWithMessage(w, http.StatusServiceUnavailable, "GIF service not configured")
		return
	}

	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	perPage := pkg.ClampInt(r.URL.Query().Get("per_page"), 24, 1, 50)
	page := pkg.ClampInt(r.URL.Query().Get("page"), 1, 1, 100)

	url := fmt.Sprintf("%s/api/v1/%s/gifs/trending?per_page=%d&page=%d&customer_id=%s",
		klipyBaseURL, h.klipyAPIKey, perPage, page, user.ID)

	results, hasNext, err := fetchKlipyResults(url)
	if err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadGateway, "failed to fetch trending GIFs")
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]any{
		"results":  results,
		"has_next": hasNext,
	})
}

// Search returns GIF search results.
// GET /api/gifs/search?q=funny&per_page=24&page=1
func (h *GifHandler) Search(w http.ResponseWriter, r *http.Request) {
	if h.klipyAPIKey == "" {
		pkg.ErrorWithMessage(w, http.StatusServiceUnavailable, "GIF service not configured")
		return
	}

	query := r.URL.Query().Get("q")
	if query == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "search query (q) is required")
		return
	}

	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	perPage := pkg.ClampInt(r.URL.Query().Get("per_page"), 24, 8, 50)
	page := pkg.ClampInt(r.URL.Query().Get("page"), 1, 1, 100)

	// query is free-text user input; it must be percent-encoded before
	// joining the query string, or a value containing "&"/"#"/"=" could
	// inject extra Klipy API parameters (query-param injection).
	reqURL := fmt.Sprintf("%s/api/v1/%s/gifs/search?q=%s&per_page=%d&page=%d&customer_id=%s",
		klipyBaseURL, h.klipyAPIKey, url.QueryEscape(query), perPage, page, user.ID)

	results, hasNext, err := fetchKlipyResults(reqURL)
	if err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadGateway, "failed to search GIFs")
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]any{
		"results":  results,
		"has_next": hasNext,
	})
}

// ── Klipy API response types ──

type klipyAPIResponse struct {
	Result bool          `json:"result"`
	Data   klipyDataWrap `json:"data"`
}

type klipyDataWrap struct {
	Data    []klipyItem `json:"data"`
	HasNext bool        `json:"has_next"`
}

type klipyItem struct {
	ID    int        `json:"id"`
	Slug  string     `json:"slug"`
	Title string     `json:"title"`
	File  klipyFiles `json:"file"`
}

// klipyFiles maps size tiers (hd, md, sm, xs) to format URLs.
type klipyFiles struct {
	HD klipyFormats `json:"hd"`
	MD klipyFormats `json:"md"`
	SM klipyFormats `json:"sm"`
	XS klipyFormats `json:"xs"`
}

type klipyFormats struct {
	GIF  *klipyMedia `json:"gif"`
	WebP *klipyMedia `json:"webp"`
	MP4  *klipyMedia `json:"mp4"`
}

type klipyMedia struct {
	URL    string `json:"url"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
	Size   int    `json:"size"`
}

// errKlipyBadURL is returned when fetchKlipyResults gets a URL that
// doesn't point at the Klipy API. The check is deliberately strict
// (prefix match against the constant klipyBaseURL) — even if a future
// caller composes the URL incorrectly, we won't issue arbitrary HTTP
// requests on behalf of the server. Without this guard the function is
// an SSRF primitive that any code path with a Go-string handle to it
// could weaponize (intranet scans, AWS metadata read, etc.).
var errKlipyBadURL = errors.New("klipy URL outside allowed origin")

func fetchKlipyResults(url string) ([]GifResult, bool, error) {
	// Hard URL guard. Reject anything that isn't a full HTTPS URL on the
	// expected Klipy origin — including http:// downgrade attempts and
	// look-alike hosts (api.klipy.com.attacker.example).
	if !strings.HasPrefix(url, klipyBaseURL+"/") {
		return nil, false, errKlipyBadURL
	}

	resp, err := klipyHTTPClient.Get(url) // #nosec G107,G704 -- host is hard-guarded above (strings.HasPrefix against the klipyBaseURL constant) and pinned for every redirect hop by klipyHTTPClient.CheckRedirect; no request-derived data can reach the scheme or host
	if err != nil {
		return nil, false, fmt.Errorf("klipy request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, false, fmt.Errorf("klipy returned %d: %s", resp.StatusCode, string(body))
	}

	var klipyResp klipyAPIResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&klipyResp); err != nil {
		return nil, false, fmt.Errorf("klipy response decode failed: %w", err)
	}

	if !klipyResp.Result {
		return nil, false, fmt.Errorf("klipy returned result=false")
	}

	results := make([]GifResult, 0, len(klipyResp.Data.Data))
	for _, item := range klipyResp.Data.Data {
		// Prefer md (medium) for message display, fallback to sm then hd
		gifURL := pickMediaURL(item.File.MD.GIF, item.File.SM.GIF, item.File.HD.GIF)
		if gifURL == "" {
			continue
		}

		// Prefer xs (extra small) for picker thumbnail
		previewURL := pickMediaURL(item.File.XS.GIF, item.File.SM.GIF, nil)
		if previewURL == "" {
			previewURL = gifURL
		}

		var width, height int
		if item.File.MD.GIF != nil {
			width = item.File.MD.GIF.Width
			height = item.File.MD.GIF.Height
		}

		results = append(results, GifResult{
			ID:         fmt.Sprintf("%d", item.ID),
			Title:      item.Title,
			PreviewURL: previewURL,
			URL:        gifURL,
			Width:      width,
			Height:     height,
		})
	}

	return results, klipyResp.Data.HasNext, nil
}

// pickMediaURL returns the first non-nil media URL from the given options.
func pickMediaURL(options ...*klipyMedia) string {
	for _, m := range options {
		if m != nil && m.URL != "" {
			return m.URL
		}
	}
	return ""
}
