package models

import (
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

var emailRegex = regexp.MustCompile(`^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$`)

func EmailRegex() *regexp.Regexp {
	return emailRegex
}

type UserStatus string

const (
	UserStatusOnline  UserStatus = "online"
	UserStatusIdle    UserStatus = "idle"
	UserStatusDND     UserStatus = "dnd"
	UserStatusOffline UserStatus = "offline"
)

type User struct {
	ID              string     `json:"id"`
	Username        string     `json:"username"`
	DisplayName     *string    `json:"display_name"`
	AvatarURL       *string    `json:"avatar_url"`
	WallpaperURL    *string    `json:"wallpaper_url"`
	PasswordHash    string     `json:"-"`
	Status          UserStatus `json:"status"`
	PrefStatus      UserStatus `json:"pref_status"`
	CustomStatus    *string    `json:"custom_status"`
	Email           *string    `json:"email"`
	Language        string     `json:"language"`
	DMPrivacy       string     `json:"dm_privacy"`
	IsPlatformAdmin   bool       `json:"is_platform_admin"`
	IsPlatformBanned      bool       `json:"is_platform_banned"`
	HasSeenDownloadPrompt bool       `json:"has_seen_download_prompt"`
	HasSeenWelcome        bool       `json:"has_seen_welcome"`
	PlatformBanReason     string     `json:"-"`
	PlatformBannedBy  string     `json:"-"`
	PlatformBannedAt  *time.Time `json:"-"`
	// LastSeenAt is stamped at the offline transition (ws disconnect,
	// manual invisible, stale-presence reset on boot). NULL until the
	// user's first recorded offline transition post-migration.
	LastSeenAt        *time.Time `json:"last_seen_at"`
	// TokenVersion is the revocation counter embedded in JWT "tv" claims.
	// Bumped by "logout from all devices" to invalidate every outstanding
	// access token in one DB write. Never exposed to clients (the live
	// session reads it via the access token claim, not the user payload).
	TokenVersion      int        `json:"-"`
	// Bot identity (migration 072). IsBot marks an automated account whose
	// password is disabled; OwnerUserID is the human who created it.
	IsBot       bool    `json:"is_bot"`
	OwnerUserID *string `json:"owner_user_id,omitempty"`
	CreatedAt         time.Time  `json:"created_at"`
}

// PublicUser is the API-facing view of another user as embedded in message,
// DM and pin payloads. Mirrors the public subset of MemberWithRoles and
// intentionally does NOT embed User: models.User carries email,
// is_platform_admin, is_platform_banned, dm_privacy, wallpaper_url,
// language, pref_status, has_seen_* and last_seen_at, all of which were
// being broadcast to every reader of a channel (security scan 2026-07-31,
// finding N-09).
type PublicUser struct {
	ID           string     `json:"id"`
	Username     string     `json:"username"`
	DisplayName  *string    `json:"display_name"`
	AvatarURL    *string    `json:"avatar_url"`
	Status       UserStatus `json:"status"`
	CustomStatus *string    `json:"custom_status"`
	CreatedAt    time.Time  `json:"created_at"`
}

// ToPublicUser narrows a full user row to the embeddable public view.
// Returns nil for a nil input so callers can pass a repo result straight
// through.
func ToPublicUser(u *User) *PublicUser {
	if u == nil {
		return nil
	}
	return &PublicUser{
		ID:           u.ID,
		Username:     u.Username,
		DisplayName:  u.DisplayName,
		AvatarURL:    u.AvatarURL,
		Status:       u.Status,
		CustomStatus: u.CustomStatus,
		CreatedAt:    u.CreatedAt,
	}
}

type CreateUserRequest struct {
	Username    string `json:"username"`
	Password    string `json:"password"`
	DisplayName string `json:"display_name"`
	Email       string `json:"email"`
	InviteCode  string `json:"invite_code"`
}

func (r *CreateUserRequest) Validate() error {
	r.Username = strings.TrimSpace(r.Username)
	usernameLen := utf8.RuneCountInString(r.Username)
	if usernameLen < 3 || usernameLen > 32 {
		return fmt.Errorf("username must be between 3 and 32 characters")
	}

	for _, ch := range r.Username {
		if !isValidUsernameChar(ch) {
			return fmt.Errorf("username can only contain letters, numbers, and underscores")
		}
	}

	if utf8.RuneCountInString(r.Password) < 8 {
		return fmt.Errorf("password must be at least 8 characters")
	}

	r.DisplayName = strings.TrimSpace(r.DisplayName)
	if utf8.RuneCountInString(r.DisplayName) > 32 {
		return fmt.Errorf("display name must be at most 32 characters")
	}

	r.Email = strings.TrimSpace(r.Email)
	if r.Email != "" && !emailRegex.MatchString(r.Email) {
		return fmt.Errorf("invalid email format")
	}

	return nil
}

type LoginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (r *LoginRequest) Validate() error {
	r.Username = strings.TrimSpace(r.Username)
	if r.Username == "" {
		return fmt.Errorf("username is required")
	}
	if r.Password == "" {
		return fmt.Errorf("password is required")
	}
	return nil
}

type UpdateUserRequest struct {
	DisplayName  *string `json:"display_name"`
	CustomStatus *string `json:"custom_status"`
	Language     *string `json:"language"`
}

// ChangeEmailRequest requires current password for security.
type ChangeEmailRequest struct {
	Password string `json:"password"`
	NewEmail string `json:"new_email"` // empty string = remove email
}

func (r *ChangeEmailRequest) Validate() error {
	if r.Password == "" {
		return fmt.Errorf("password is required")
	}
	r.NewEmail = strings.TrimSpace(r.NewEmail)
	if r.NewEmail != "" && !emailRegex.MatchString(r.NewEmail) {
		return fmt.Errorf("invalid email format")
	}
	return nil
}

func isValidUsernameChar(ch rune) bool {
	return (ch >= 'a' && ch <= 'z') ||
		(ch >= 'A' && ch <= 'Z') ||
		(ch >= '0' && ch <= '9') ||
		ch == '_'
}
