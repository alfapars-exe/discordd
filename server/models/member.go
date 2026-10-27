package models

import (
	"fmt"
	"math"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/argeinfina/hichat/pkg"
)

// MemberWithRoles is the API-facing view of a server member.
// Intentionally does NOT embed User to avoid leaking PasswordHash.
type MemberWithRoles struct {
	ID          string  `json:"id"`
	Username    string  `json:"username"`
	DisplayName *string `json:"display_name"`
	AvatarURL   *string `json:"avatar_url"`
	// Per-server nickname (migration 065). NULL when unset — clients
	// fall back to DisplayName, then Username. Empty strings are
	// coerced to NULL by the API layer so saving a blank value
	// effectively clears the nickname.
	Nickname             *string    `json:"nickname,omitempty"`
	Status               UserStatus `json:"status"`
	CustomStatus         *string    `json:"custom_status"`
	CreatedAt            time.Time  `json:"created_at"`
	Roles                []Role     `json:"roles"`
	EffectivePermissions Permission `json:"effective_permissions"`
	// TimeoutExpiresAt — when set, the member is currently under a
	// moderator-imposed timeout that ends at this UTC timestamp. nil
	// means no active timeout. The repo already filters expired rows,
	// so this is either future-dated or omitted. Clients use it to draw
	// the "timed out until X" banner + clock badge without a separate
	// API call.
	TimeoutExpiresAt *time.Time `json:"timeout_expires_at,omitempty"`
	// LastSeenAt is the offline-transition timestamp from users.last_seen_at.
	// nil for currently-online members or users never yet stamped. Used by
	// the client to render "last seen X ago" under offline member names.
	LastSeenAt *time.Time `json:"last_seen_at,omitempty"`
	// Public profile fields (migration 085), copied verbatim from User.
	AvatarAnimatedURL *string `json:"avatar_animated_url"`
	BannerURL         *string `json:"banner_url"`
	BannerAnimatedURL *string `json:"banner_animated_url"`
	Bio               *string `json:"bio"`
	Pronouns          *string `json:"pronouns"`
	AccentColor       *string `json:"accent_color"`
	// ProfileFieldsRedacted marks an audience-filtered or invalidation payload.
	// Clients can refetch through the same server-side policy to refresh fields.
	ProfileFieldsRedacted bool `json:"profile_fields_redacted,omitempty"`
}

// RedactProfileFields clears optional profile-card data before a broad
// broadcast or a response whose viewer failed the profile audience policy.
func (m *MemberWithRoles) RedactProfileFields() {
	if m == nil {
		return
	}
	m.AvatarAnimatedURL = nil
	m.BannerURL = nil
	m.BannerAnimatedURL = nil
	m.Bio = nil
	m.Pronouns = nil
	m.AccentColor = nil
	m.ProfileFieldsRedacted = true
}

// ToMemberWithRoles builds a MemberWithRoles from a User and their roles.
// Computes effective permissions via bitwise OR across all roles. Server-
// scoped data like the per-server nickname is filled in by the caller
// (member_service) after fetching it from the membership row.
func ToMemberWithRoles(user *User, roles []Role) MemberWithRoles {
	// nil slice serializes to JSON null — use empty slice for safe frontend iteration
	if roles == nil {
		roles = []Role{}
	}

	var effectivePerms Permission
	for _, role := range roles {
		effectivePerms |= role.Permissions
	}

	lastSeenAt := user.LastSeenAt
	if user.PrefStatus == UserStatusOffline {
		// Invisible mode: don't let the offline-transition timestamp leak
		// through the member list — that would deanonymize the exact
		// moment a user went invisible, defeating the point of the
		// pref_status="offline" privacy feature (see ws handler /
		// init_callbacks SetInvisible path, which treats pref_status
		// offline as "hide from online users"). The DB column itself is
		// still stamped so the user's own history is intact when they
		// come back online — only the API-facing value is suppressed.
		lastSeenAt = nil
	}

	return MemberWithRoles{
		ID:                   user.ID,
		Username:             user.Username,
		DisplayName:          user.DisplayName,
		AvatarURL:            user.AvatarURL,
		Status:               user.Status,
		CustomStatus:         user.CustomStatus,
		CreatedAt:            user.CreatedAt,
		Roles:                roles,
		EffectivePermissions: effectivePerms,
		LastSeenAt:           lastSeenAt,
		AvatarAnimatedURL:    user.AvatarAnimatedURL,
		BannerURL:            user.BannerURL,
		BannerAnimatedURL:    user.BannerAnimatedURL,
		Bio:                  user.Bio,
		Pronouns:             user.Pronouns,
		AccentColor:          user.AccentColor,
	}
}

// NicknameRequest — body for PATCH /api/servers/{id}/members/{uid}/nickname.
// nil Nickname (omitted JSON field) means "no change"; explicit "" clears.
// Capped at 32 runes to match the display_name limit so role badges and
// sidebar rows don't blow out at unrelated lengths.
type NicknameRequest struct {
	Nickname *string `json:"nickname"`
}

func (r *NicknameRequest) Validate() error {
	if r.Nickname == nil {
		return fmt.Errorf("nickname field is required (use empty string to clear)")
	}
	trimmed := strings.TrimSpace(*r.Nickname)
	r.Nickname = &trimmed
	if utf8.RuneCountInString(trimmed) > 32 {
		return fmt.Errorf("nickname must be at most 32 characters")
	}
	if pkg.ContainsSteeringChars(trimmed) {
		return fmt.Errorf("nickname contains disallowed control or formatting characters")
	}
	return nil
}

// UpdateProfileRequest — nil fields are not updated (partial update).
type UpdateProfileRequest struct {
	Username     *string `json:"username"`
	DisplayName  *string `json:"display_name"`
	AvatarURL    *string `json:"avatar_url"`
	CustomStatus *string `json:"custom_status"`
	Language     *string `json:"language"`
	DMPrivacy    *string `json:"dm_privacy"`
	// Bio / Pronouns / AccentColor: nil = no change, "" = clear (NULL).
	// Validate normalises them in place (see models/profile.go).
	Bio         *string `json:"bio"`
	Pronouns    *string `json:"pronouns"`
	AccentColor *string `json:"accent_color"`

	// Server-internal media fields — never decoded from a request body.
	// Only handlers/avatar.go sets them, after writing the file itself.
	// AvatarAnimatedURL is applied only alongside AvatarURL (nil clears
	// it); ClearBanner wins over BannerURL.
	AvatarAnimatedURL *string `json:"-"`
	BannerURL         *string `json:"-"`
	BannerAnimatedURL *string `json:"-"`
	ClearBanner       bool    `json:"-"`
}

var allowedLanguages = map[string]bool{
	"en": true,
	"tr": true,
}

var allowedDMPrivacy = map[string]bool{
	"everyone":        true,
	"message_request": true,
	"friends_only":    true,
}

func (r *UpdateProfileRequest) Validate() error {
	if r.Username != nil {
		trimmed := strings.TrimSpace(*r.Username)
		r.Username = &trimmed
		usernameLen := utf8.RuneCountInString(trimmed)
		if usernameLen < 3 || usernameLen > 32 {
			return fmt.Errorf("username must be between 3 and 32 characters")
		}
		for _, ch := range trimmed {
			if !isValidUsernameChar(ch) {
				return fmt.Errorf("username can only contain letters, numbers, and underscores")
			}
		}
	}
	if r.DisplayName != nil {
		if utf8.RuneCountInString(*r.DisplayName) > 32 {
			return fmt.Errorf("display name must be at most 32 characters")
		}
		if pkg.ContainsSteeringChars(*r.DisplayName) {
			return fmt.Errorf("display name contains disallowed control or formatting characters")
		}
	}
	if r.CustomStatus != nil {
		if utf8.RuneCountInString(*r.CustomStatus) > 128 {
			return fmt.Errorf("custom status must be at most 128 characters")
		}
		if pkg.ContainsSteeringChars(*r.CustomStatus) {
			return fmt.Errorf("custom status contains disallowed control or formatting characters")
		}
	}
	if r.Language != nil && !allowedLanguages[*r.Language] {
		return fmt.Errorf("unsupported language: %s", *r.Language)
	}
	if r.DMPrivacy != nil && !allowedDMPrivacy[*r.DMPrivacy] {
		return fmt.Errorf("unsupported dm_privacy value: %s", *r.DMPrivacy)
	}
	if r.Bio != nil {
		v, err := NormalizeBio(*r.Bio)
		if err != nil {
			return err
		}
		r.Bio = &v
	}
	if r.Pronouns != nil {
		v, err := NormalizePronouns(*r.Pronouns)
		if err != nil {
			return err
		}
		r.Pronouns = &v
	}
	if r.AccentColor != nil {
		v, err := NormalizeAccentColor(*r.AccentColor)
		if err != nil {
			return err
		}
		r.AccentColor = &v
	}
	return nil
}

// RoleModifyRequest uses a declarative approach — the full target role list
// is sent, and the service diffs against current roles.
type RoleModifyRequest struct {
	RoleIDs []string `json:"role_ids"`
}

func (r *RoleModifyRequest) Validate() error {
	if len(r.RoleIDs) == 0 {
		return fmt.Errorf("at least one role is required")
	}
	return nil
}

// HighestPosition returns the highest role position in the list.
// Owner role returns math.MaxInt32 to always outrank any position value.
func HighestPosition(roles []Role) int {
	if HasOwnerRole(roles) {
		return math.MaxInt32
	}
	max := 0
	for _, r := range roles {
		if r.Position > max {
			max = r.Position
		}
	}
	return max
}
