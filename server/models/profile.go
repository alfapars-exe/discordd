// Package models — profile.go: the public profile view (GET
// /api/users/{userId}/profile) and the normalisers for the user-written
// profile fields added in migration 085.
package models

import (
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/argeinfina/hichat/pkg"
)

const (
	// BioMaxRunes caps the "About me" text (Discord parity).
	BioMaxRunes = 190
	// PronounsMaxRunes caps the single-line pronouns field.
	PronounsMaxRunes = 40
)

var accentColorRegex = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// UserProfile is the public profile card of any user. Like PublicUser it is
// a deliberate allowlist: bio, pronouns, accent colour, banner and animated
// avatar are public by design (the user writes them, defaults are empty),
// while email, status, pref_status, last_seen_at, dm_privacy, language,
// wallpaper_url, the is_platform_* / has_seen_* flags and owner_user_id are
// never part of it. Presence is omitted on purpose: it travels on its own
// channel, and leaving it out keeps invisible mode from leaking here.
type UserProfile struct {
	ID                string    `json:"id"`
	Username          string    `json:"username"`
	DisplayName       *string   `json:"display_name"`
	AvatarURL         *string   `json:"avatar_url"`
	AvatarAnimatedURL *string   `json:"avatar_animated_url"`
	BannerURL         *string   `json:"banner_url"`
	BannerAnimatedURL *string   `json:"banner_animated_url"`
	Bio               *string   `json:"bio"`
	Pronouns          *string   `json:"pronouns"`
	AccentColor       *string   `json:"accent_color"`
	CustomStatus      *string   `json:"custom_status"`
	IsBot             bool      `json:"is_bot"`
	CreatedAt         time.Time `json:"created_at"`
}

// ToUserProfile narrows a full user row to the public profile view.
// Returns nil for a nil input.
func ToUserProfile(u *User) *UserProfile {
	if u == nil {
		return nil
	}
	return &UserProfile{
		ID:                u.ID,
		Username:          u.Username,
		DisplayName:       u.DisplayName,
		AvatarURL:         u.AvatarURL,
		AvatarAnimatedURL: u.AvatarAnimatedURL,
		BannerURL:         u.BannerURL,
		BannerAnimatedURL: u.BannerAnimatedURL,
		Bio:               u.Bio,
		Pronouns:          u.Pronouns,
		AccentColor:       u.AccentColor,
		CustomStatus:      u.CustomStatus,
		IsBot:             u.IsBot,
		CreatedAt:         u.CreatedAt,
	}
}

// NormalizeBio strips "\r" (so CRLF and LF count the same), trims
// surrounding whitespace, then enforces BioMaxRunes and rejects bidi /
// control steering characters. "\n" and "\t" are allowed — the bio is
// multi-line. Returns "" for an all-whitespace input (caller treats "" as
// clear). Same steps as NormalizeNote (models/saved.go) with its own cap.
func NormalizeBio(s string) (string, error) {
	s = strings.TrimSpace(strings.ReplaceAll(s, "\r", ""))
	if utf8.RuneCountInString(s) > BioMaxRunes {
		return "", fmt.Errorf("bio must be at most %d characters", BioMaxRunes)
	}
	if pkg.ContainsSteeringCharsMultiline(s) {
		return "", fmt.Errorf("bio contains disallowed control or formatting characters")
	}
	return s, nil
}

// NormalizePronouns trims surrounding whitespace, enforces PronounsMaxRunes
// and rejects steering characters — including "\n": pronouns are one line.
func NormalizePronouns(s string) (string, error) {
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) > PronounsMaxRunes {
		return "", fmt.Errorf("pronouns must be at most %d characters", PronounsMaxRunes)
	}
	if pkg.ContainsSteeringChars(s) {
		return "", fmt.Errorf("pronouns contain disallowed control or formatting characters")
	}
	return s, nil
}

// NormalizeAccentColor accepts "" (clear) or exactly "#rrggbb" and returns
// it lower-cased; anything else (short form, named colours, non-hex) fails.
func NormalizeAccentColor(s string) (string, error) {
	if s == "" {
		return "", nil
	}
	if !accentColorRegex.MatchString(s) {
		return "", fmt.Errorf("accent_color must be a #rrggbb hex colour")
	}
	return strings.ToLower(s), nil
}
