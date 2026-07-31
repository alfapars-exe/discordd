package main

// OG meta-tag responses for social media crawlers hitting /invite/{code}.

import (
	"fmt"
	"html"
	"net/http"
	"regexp"
	"strings"

	"github.com/argeinfina/hichat/services"
)

var invitePathRe = regexp.MustCompile(`^/invite/([a-f0-9]{16})$`)

var crawlerPatterns = []string{
	"whatsapp", "telegrambot", "twitterbot", "facebookexternalhit",
	"facebot", "linkedinbot", "slackbot", "discordbot",
	"googlebot", "bingbot",
}

func isCrawler(ua string) bool {
	lower := strings.ToLower(ua)
	for _, pattern := range crawlerPatterns {
		if strings.Contains(lower, pattern) {
			return true
		}
	}
	return false
}

// serveInviteOG returns OG meta tag HTML for /invite/{code} crawler requests.
// Social media crawlers can't execute JS, so we serve a minimal HTML with meta tags.
// Returns true if the response was written.
func serveInviteOG(w http.ResponseWriter, r *http.Request, inviteSvc services.InviteService, appURL string) bool {
	matches := invitePathRe.FindStringSubmatch(r.URL.Path)
	if matches == nil {
		return false
	}
	code := matches[1]

	preview, err := inviteSvc.GetPreview(r.Context(), code)
	if err != nil {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		// Error means the crawler already disconnected — nothing to do.
		_, _ = fmt.Fprint(w, `<!DOCTYPE html><html><head>
<meta property="og:title" content="HiChat! — Davet">
<meta property="og:description" content="Bu davet geçersiz veya süresi dolmuş">
<meta property="og:site_name" content="HiChat!">
</head><body></body></html>`)
		return true
	}

	// Escaped inline at each Fprintf sink below, not once here and reused —
	// gosec's G705 (XSS) taint tracker only recognises html.EscapeString as a
	// sanitizer when it wraps the argument at the point of use, not when a
	// pre-escaped variable is read back several lines later.
	rawTitle := preview.ServerName
	description := fmt.Sprintf("%d members", preview.MemberCount)

	var imageURL string
	if preview.ServerIconURL != nil && *preview.ServerIconURL != "" {
		if appURL != "" {
			imageURL = appURL + *preview.ServerIconURL
		} else {
			imageURL = *preview.ServerIconURL
		}
	} else if appURL != "" {
		imageURL = appURL + "/hlogo.png"
	}

	inviteURL := r.URL.Path
	if appURL != "" {
		inviteURL = appURL + r.URL.Path
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	// #nosec G705 -- every interpolated value below is wrapped in html.EscapeString
	// (escapes <, >, &, ', ") at its point of use; description is a pure "%d
	// members" integer format with no injectable content. gosec's G705 taint
	// tracker does not appear to recognise html.EscapeString as a sanitizer,
	// but it escapes the exact character set html/template would here.
	// Fprintf errors below mean the crawler already disconnected — nothing to do.
	_, _ = fmt.Fprintf(w, `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta property="og:type" content="website">
<meta property="og:site_name" content="HiChat!">
<meta property="og:title" content="%s">
<meta property="og:description" content="%s">
<meta property="og:url" content="%s">`,
		html.EscapeString(rawTitle), description, html.EscapeString(inviteURL))

	if imageURL != "" {
		_, _ = fmt.Fprintf(w, `
<meta property="og:image" content="%s">`, html.EscapeString(imageURL))
	}

	// #nosec G705 -- same reasoning as the DOCTYPE Fprintf above: rawTitle is
	// escaped inline, description is a pure integer format.
	_, _ = fmt.Fprintf(w, `
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="%s">
<meta name="twitter:description" content="%s">`,
		html.EscapeString(rawTitle), description)

	if imageURL != "" {
		_, _ = fmt.Fprintf(w, `
<meta name="twitter:image" content="%s">`, html.EscapeString(imageURL))
	}

	// Error means the crawler already disconnected — nothing to do.
	_, _ = fmt.Fprint(w, `
</head>
<body></body>
</html>`)

	return true
}
