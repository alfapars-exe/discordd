package models

import (
	"fmt"
	"html"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	EmailCampaignCategoryAnnouncements   = "announcements"
	EmailCampaignCategoryTips            = "tips"
	EmailCampaignCategoryRecommendations = "recommendations"
	EmailCampaignMaxSubjectRunes         = 120
	EmailCampaignMaxBodyRunes            = 10_000
	EmailCampaignMaxLifetime             = 30 * 24 * time.Hour
	EmailCampaignMinLifetime             = time.Hour
)

// EmailCampaign is an immutable platform-admin announcement draft. Body is
// always plain text; rendering escapes it and does not create clickable URLs.
type EmailCampaign struct {
	ID             string  `json:"id"`
	Category       string  `json:"category"`
	Subject        string  `json:"subject"`
	Body           string  `json:"body"`
	Status         string  `json:"status"`
	ExpiresAt      string  `json:"expires_at"`
	CreatedBy      string  `json:"created_by"`
	CreatedAt      string  `json:"created_at"`
	PublishedBy    *string `json:"published_by,omitempty"`
	PublishedAt    *string `json:"published_at,omitempty"`
	RecipientCount int     `json:"recipient_count"`
}

type CreateEmailCampaignRequest struct {
	Category  string `json:"category"`
	Subject   string `json:"subject"`
	Body      string `json:"body"`
	ExpiresAt string `json:"expires_at"`
}

type EmailCampaignPreview struct {
	Campaign           *EmailCampaign `json:"campaign"`
	BodyHTML           string         `json:"body_html"`
	EligibleRecipients int            `json:"eligible_recipients"`
}

func (r *CreateEmailCampaignRequest) Validate(now time.Time) error {
	if r == nil {
		return fmt.Errorf("campaign request is required")
	}
	switch r.Category {
	case EmailCampaignCategoryAnnouncements, EmailCampaignCategoryTips, EmailCampaignCategoryRecommendations:
	default:
		return fmt.Errorf("unsupported campaign category")
	}
	if strings.TrimSpace(r.Subject) != r.Subject || r.Subject == "" || utf8.RuneCountInString(r.Subject) > EmailCampaignMaxSubjectRunes || hasCampaignControl(r.Subject, false) {
		return fmt.Errorf("invalid campaign subject")
	}
	if strings.TrimSpace(r.Body) != r.Body || r.Body == "" || utf8.RuneCountInString(r.Body) > EmailCampaignMaxBodyRunes || hasCampaignControl(r.Body, true) {
		return fmt.Errorf("invalid campaign body")
	}
	expires, err := time.Parse(time.RFC3339Nano, r.ExpiresAt)
	if err != nil || expires.Before(now.Add(EmailCampaignMinLifetime)) || expires.After(now.Add(EmailCampaignMaxLifetime)) {
		return fmt.Errorf("campaign expiry must be between one hour and thirty days from now")
	}
	return nil
}

func hasCampaignControl(value string, allowNewline bool) bool {
	for _, r := range value {
		if r == '\n' && allowNewline {
			continue
		}
		if r == '\r' && allowNewline {
			continue
		}
		if r == '\t' && allowNewline {
			continue
		}
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

// RenderEmailCampaignBody produces safe HTML from plain text. URLs remain
// inert text, so campaigns cannot inject arbitrary links or markup.
func RenderEmailCampaignBody(body string) string {
	lines := strings.Split(strings.ReplaceAll(body, "\r\n", "\n"), "\n")
	for i, line := range lines {
		lines[i] = html.EscapeString(line)
	}
	return "<p>" + strings.Join(lines, "<br>\n") + "</p>"
}
