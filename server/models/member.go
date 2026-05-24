package models

import (
	"fmt"
	"math"
	"strings"
	"time"
	"unicode/utf8"
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
	if r.DisplayName != nil && utf8.RuneCountInString(*r.DisplayName) > 32 {
		return fmt.Errorf("display name must be at most 32 characters")
	}
	if r.CustomStatus != nil && utf8.RuneCountInString(*r.CustomStatus) > 128 {
		return fmt.Errorf("custom status must be at most 128 characters")
	}
	if r.Language != nil && !allowedLanguages[*r.Language] {
		return fmt.Errorf("unsupported language: %s", *r.Language)
	}
	if r.DMPrivacy != nil && !allowedDMPrivacy[*r.DMPrivacy] {
		return fmt.Errorf("unsupported dm_privacy value: %s", *r.DMPrivacy)
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
