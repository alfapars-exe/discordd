// Package services — LinkPreviewService: fetches Open Graph metadata from URLs.
//
// Security:
//   - SSRF protection: private/reserved IP ranges blocked (custom DialContext)
//   - Body limit: max 512KB HTML
//   - Timeout: 5s HTTP timeout
//   - Redirect limit: max 3 redirects
//
// Cache:
//   - SQLite link_previews table, URL-deduplicated, 24h TTL
//   - Failed fetches are also cached to prevent retries
//
// Parsing priority: og:* > twitter:* > <title>/<meta name="description">
package services

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"golang.org/x/net/html"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
)

// LinkPreviewService fetches and caches URL metadata.
type LinkPreviewService interface {
	GetPreview(ctx context.Context, rawURL string) (*models.LinkPreview, error)
}

const cacheTTL = 24 * time.Hour
const maxBodySize = 512 * 1024
const maxRedirects = 3

// defaultOEmbedBase is YouTube's public oEmbed endpoint. Kept as a field on
// the service (not inlined) so tests can point it at an httptest server —
// the SSRF dialer rejects loopback addresses, making the production client
// unable to reach local test fixtures.
const defaultOEmbedBase = "https://www.youtube.com/oembed"

type linkPreviewService struct {
	repo       repository.LinkPreviewRepository
	client     *http.Client
	oembedBase string
}

// NewLinkPreviewService creates a service with an SSRF-safe HTTP client.
// DNS resolution results are checked against private IP ranges.
func NewLinkPreviewService(repo repository.LinkPreviewRepository) LinkPreviewService {
	safeDialer := &net.Dialer{Timeout: 5 * time.Second}

	transport := &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, fmt.Errorf("invalid address: %w", err)
			}

			// Only standard web ports — stops the preview fetcher from being
			// used as a port scanner / open proxy against services listening
			// on non-web ports of an otherwise-public host.
			if port != "80" && port != "443" {
				return nil, fmt.Errorf("SSRF blocked: port %s not allowed", port)
			}

			ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
			if err != nil {
				return nil, fmt.Errorf("DNS lookup failed: %w", err)
			}

			for _, ip := range ips {
				if isPrivateIP(ip.IP) {
					return nil, fmt.Errorf("SSRF blocked: %s resolves to private IP %s", host, ip.IP)
				}
			}

			return safeDialer.DialContext(ctx, network, net.JoinHostPort(ips[0].IP.String(), port))
		},
		TLSClientConfig:    &tls.Config{InsecureSkipVerify: false},
		DisableKeepAlives:  true,
		ForceAttemptHTTP2:  false,
		MaxIdleConns:       10,
		IdleConnTimeout:    30 * time.Second,
		DisableCompression: false,
	}

	client := &http.Client{
		Transport: transport,
		Timeout:   8 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= maxRedirects {
				return fmt.Errorf("too many redirects (max %d)", maxRedirects)
			}
			// SSRF check on redirect target
			host := req.URL.Hostname()
			ips, err := net.DefaultResolver.LookupIPAddr(req.Context(), host)
			if err != nil {
				return fmt.Errorf("redirect DNS lookup failed: %w", err)
			}
			for _, ip := range ips {
				if isPrivateIP(ip.IP) {
					return fmt.Errorf("SSRF blocked on redirect: %s resolves to private IP", host)
				}
			}
			return nil
		},
	}

	return &linkPreviewService{repo: repo, client: client, oembedBase: defaultOEmbedBase}
}

// newLinkPreviewServiceForTest wires a custom HTTP client and oEmbed base —
// required because the production SSRF dialer blocks loopback IPs and
// non-80/443 ports, so httptest servers are unreachable through it.
func newLinkPreviewServiceForTest(repo repository.LinkPreviewRepository, client *http.Client, oembedBase string) *linkPreviewService {
	return &linkPreviewService{repo: repo, client: client, oembedBase: oembedBase}
}

func (s *linkPreviewService) GetPreview(ctx context.Context, rawURL string) (*models.LinkPreview, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("invalid URL: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, fmt.Errorf("unsupported scheme: %s", parsed.Scheme)
	}
	if parsed.Host == "" {
		return nil, fmt.Errorf("empty host")
	}

	normalizedURL := parsed.String()

	// Cache check
	cached, err := s.repo.GetByURL(ctx, normalizedURL)
	if err != nil {
		return nil, fmt.Errorf("cache lookup: %w", err)
	}
	if cached != nil {
		fetchedAt, parseErr := time.Parse("2006-01-02 15:04:05", cached.FetchedAt)
		if parseErr == nil && time.Since(fetchedAt) < cacheTTL {
			if cached.Error {
				return nil, fmt.Errorf("previously failed URL")
			}
			return cached, nil
		}
	}

	// YouTube actively serves consent-walled / JS-rendered HTML to bot
	// User-Agents, so the generic OG scraper at fetchAndParse cannot
	// recover a title for youtube.com/youtu.be URLs and returns an error
	// that we'd then negative-cache for 24h. The public oEmbed endpoint
	// has none of those problems — it is the official metadata channel
	// and ignores UA. Branching here keeps the cache lookup + upsert
	// behavior identical to the generic path.
	var (
		preview  *models.LinkPreview
		fetchErr error
	)
	if isYouTubeHost(parsed.Host) {
		preview, fetchErr = s.fetchYouTubeOEmbed(ctx, normalizedURL)
	} else {
		preview, fetchErr = s.fetchAndParse(ctx, normalizedURL, parsed)
	}
	if fetchErr != nil {
		// Cache failed fetches to prevent retries
		errPreview := &models.LinkPreview{URL: normalizedURL, Error: true}
		_ = s.repo.Upsert(ctx, errPreview)
		return nil, fetchErr
	}

	// Cache write error is non-critical — still return the preview
	if err := s.repo.Upsert(ctx, preview); err != nil {
		_ = err
	}

	return preview, nil
}

// isYouTubeHost identifies the URLs that should bypass the generic OG
// scraper. Subdomains are stripped so apex, www, m, and music variants
// all match; comparison is case-insensitive because RFC 3986 hosts are.
func isYouTubeHost(host string) bool {
	h := strings.ToLower(host)
	h = strings.TrimPrefix(h, "www.")
	h = strings.TrimPrefix(h, "m.")
	h = strings.TrimPrefix(h, "music.")
	return h == "youtube.com" || h == "youtu.be"
}

// fetchYouTubeOEmbed pulls metadata from YouTube's public oEmbed
// endpoint. No auth, no bot UA gate, official API surface. Returns the
// same LinkPreview shape as fetchAndParse so the caller cache path is
// uniform. SSRF protection still applies — the SSRF-safe transport on
// s.client resolves www.youtube.com to a public IP and refuses if not.
func (s *linkPreviewService) fetchYouTubeOEmbed(ctx context.Context, originalURL string) (*models.LinkPreview, error) {
	endpoint := s.oembedBase + "?url=" + url.QueryEscape(originalURL) + "&format=json"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("create oembed request: %w", err)
	}
	req.Header.Set("Accept", "application/json")

	resp, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("oembed fetch failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		// 401/404 here means the video is private / deleted / age-restricted
		// (oEmbed refuses), or YouTube returned an error for a deformed URL.
		// In every case the caller treats this as a fetch failure and falls
		// into the negative-cache path — same shape as the generic scraper.
		return nil, fmt.Errorf("oembed HTTP %d", resp.StatusCode)
	}

	limited := io.LimitReader(resp.Body, maxBodySize)
	var data struct {
		Title        string `json:"title"`
		AuthorName   string `json:"author_name"`
		ThumbnailURL string `json:"thumbnail_url"`
	}
	if err := json.NewDecoder(limited).Decode(&data); err != nil {
		return nil, fmt.Errorf("oembed decode: %w", err)
	}

	if data.Title == "" {
		// No title is the same shape as a failed scrape — surface as error
		// so we don't cache a half-empty success.
		return nil, fmt.Errorf("oembed: empty title")
	}

	preview := &models.LinkPreview{URL: originalURL, Error: false}
	preview.Title = &data.Title
	if data.AuthorName != "" {
		// Channel name as description — no English-only prefix so the cached
		// value stays locale-neutral. The UI degrades gracefully if absent.
		preview.Description = &data.AuthorName
	}
	if data.ThumbnailURL != "" {
		preview.ImageURL = &data.ThumbnailURL
	}
	siteName := "YouTube"
	preview.SiteName = &siteName
	favicon := "https://www.youtube.com/favicon.ico"
	preview.FaviconURL = &favicon
	return preview, nil
}

func (s *linkPreviewService) fetchAndParse(ctx context.Context, normalizedURL string, parsed *url.URL) (*models.LinkPreview, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, normalizedURL, nil)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; MqviBot/1.0; +https://mqvi.net)")
	req.Header.Set("Accept", "text/html,application/xhtml+xml")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")

	resp, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	ct := resp.Header.Get("Content-Type")
	if !strings.Contains(ct, "text/html") && !strings.Contains(ct, "application/xhtml") {
		return nil, fmt.Errorf("not HTML: %s", ct)
	}

	limitedBody := io.LimitReader(resp.Body, maxBodySize)
	og := parseOGMetadata(limitedBody)

	// Resolve relative URLs to absolute
	if og.imageURL != "" && !strings.HasPrefix(og.imageURL, "http") {
		if ref, err := parsed.Parse(og.imageURL); err == nil {
			og.imageURL = ref.String()
		}
	}
	if og.faviconURL != "" && !strings.HasPrefix(og.faviconURL, "http") {
		if ref, err := parsed.Parse(og.faviconURL); err == nil {
			og.faviconURL = ref.String()
		}
	}

	if og.faviconURL == "" {
		og.faviconURL = fmt.Sprintf("%s://%s/favicon.ico", parsed.Scheme, parsed.Host)
	}

	preview := &models.LinkPreview{
		URL:   normalizedURL,
		Error: false,
	}
	if og.title != "" {
		preview.Title = &og.title
	}
	if og.description != "" {
		preview.Description = &og.description
	}
	if og.imageURL != "" {
		preview.ImageURL = &og.imageURL
	}
	if og.siteName != "" {
		preview.SiteName = &og.siteName
	}
	if og.faviconURL != "" {
		preview.FaviconURL = &og.faviconURL
	}

	if preview.Title == nil {
		return nil, fmt.Errorf("no OG title found")
	}

	return preview, nil
}

type ogData struct {
	title       string
	description string
	imageURL    string
	siteName    string
	faviconURL  string
}

// parseOGMetadata extracts OG/Twitter Card metadata from HTML.
// Priority: og:title > twitter:title > <title>, stops at <body>.
func parseOGMetadata(r io.Reader) ogData {
	var og ogData
	// Twitter Card values are collected separately and merged after parsing
	// so the documented priority (og:* > twitter:*) holds regardless of the
	// order the <meta> tags appear in the document. Previously a
	// twitter:title earlier in <head> would shadow a later og:title.
	var twTitle, twDesc, twImage string
	var htmlTitle string
	var metaDesc string
	var inTitle bool
	var inHead bool

	tokenizer := html.NewTokenizer(r)

	for {
		tt := tokenizer.Next()
		switch tt {
		case html.ErrorToken:
			goto done

		case html.StartTagToken, html.SelfClosingTagToken:
			tn, hasAttr := tokenizer.TagName()
			tagName := string(tn)

			switch tagName {
			case "head":
				inHead = true

			case "body":
				goto done

			case "title":
				if inHead {
					inTitle = true
				}

			case "meta":
				if !hasAttr {
					continue
				}
				attrs := readAttrs(tokenizer)
				prop := attrs["property"]
				name := attrs["name"]
				content := attrs["content"]

				if content == "" {
					continue
				}

				switch prop {
				case "og:title":
					if og.title == "" {
						og.title = content
					}
				case "og:description":
					if og.description == "" {
						og.description = content
					}
				case "og:image":
					if og.imageURL == "" {
						og.imageURL = content
					}
				case "og:site_name":
					if og.siteName == "" {
						og.siteName = content
					}
				}

				switch name {
				case "twitter:title":
					if twTitle == "" {
						twTitle = content
					}
				case "twitter:description":
					if twDesc == "" {
						twDesc = content
					}
				case "twitter:image":
					if twImage == "" {
						twImage = content
					}
				case "description":
					if metaDesc == "" {
						metaDesc = content
					}
				}

			case "link":
				if !hasAttr {
					continue
				}
				attrs := readAttrs(tokenizer)
				rel := strings.ToLower(attrs["rel"])
				href := attrs["href"]
				if href != "" && (rel == "icon" || rel == "shortcut icon") {
					if og.faviconURL == "" {
						og.faviconURL = href
					}
				}
			}

		case html.TextToken:
			if inTitle {
				htmlTitle = strings.TrimSpace(string(tokenizer.Text()))
			}

		case html.EndTagToken:
			tn, _ := tokenizer.TagName()
			if string(tn) == "title" {
				inTitle = false
			}
			if string(tn) == "head" {
				goto done
			}
		}
	}

done:
	// Merge in documented priority order: og:* > twitter:* > <title>/meta-desc.
	if og.title == "" {
		og.title = twTitle
	}
	if og.title == "" {
		og.title = htmlTitle
	}
	if og.description == "" {
		og.description = twDesc
	}
	if og.description == "" {
		og.description = metaDesc
	}
	if og.imageURL == "" {
		og.imageURL = twImage
	}

	if len(og.title) > 300 {
		og.title = og.title[:300]
	}
	if len(og.description) > 500 {
		og.description = og.description[:500]
	}

	return og
}

func readAttrs(t *html.Tokenizer) map[string]string {
	attrs := make(map[string]string)
	for {
		key, val, more := t.TagAttr()
		if len(key) > 0 {
			attrs[string(key)] = string(val)
		}
		if !more {
			break
		}
	}
	return attrs
}

// ssrfReservedCIDRs are ranges the stdlib net.IP helpers don't classify as
// private but which must still be blocked for SSRF: carrier-grade NAT,
// IETF protocol assignments, test/benchmark nets, and class-E reserved.
var ssrfReservedCIDRs = func() []*net.IPNet {
	nets := make([]*net.IPNet, 0, 7)
	for _, c := range []string{
		"100.64.0.0/10",   // RFC 6598 carrier-grade NAT
		"192.0.0.0/24",    // RFC 6890 IETF protocol assignments
		"192.0.2.0/24",    // TEST-NET-1
		"198.18.0.0/15",   // RFC 2544 benchmarking
		"198.51.100.0/24", // TEST-NET-2
		"203.0.113.0/24",  // TEST-NET-3
		"240.0.0.0/4",     // reserved (class E)
	} {
		if _, n, err := net.ParseCIDR(c); err == nil {
			nets = append(nets, n)
		}
	}
	return nets
}()

// isPrivateIP checks if an IP is in a private/reserved range (SSRF protection).
func isPrivateIP(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() {
		return true
	}
	// Normalise IPv4-mapped IPv6 (::ffff:a.b.c.d) so a v6 literal can't
	// smuggle a blocked v4 address (metadata/CGNAT) past the CIDR checks.
	if v4 := ip.To4(); v4 != nil {
		ip = v4
	}
	for _, n := range ssrfReservedCIDRs {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}
