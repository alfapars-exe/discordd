package models

import (
	"fmt"
	"time"
	"unicode/utf8"
)

// Ban — per-server ban. Checked on login and WS connect.
// ExpiresAt nil = permanent ban (original behaviour); non-nil = temp ban
// that lifts itself automatically when the row's expires_at passes
// (enforced by the repo filter, no cleanup job).
type Ban struct {
	ServerID  string     `json:"server_id"`
	UserID    string     `json:"user_id"`
	Username  string     `json:"username"`
	Reason    string     `json:"reason"`
	BannedBy  string     `json:"banned_by"`
	CreatedAt time.Time  `json:"created_at"`
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
}

// BanRequest — optional DurationSeconds turns the ban into a temp ban.
// nil / 0 = permanent. Capped at 1 year on the server to prevent UI
// fat-finger sending 999999999 from the duration picker.
type BanRequest struct {
	Reason          string `json:"reason"`
	DurationSeconds *int64 `json:"duration_seconds,omitempty"`
}

const maxBanDurationSeconds = 365 * 24 * 60 * 60 // 1 year

func (r *BanRequest) Validate() error {
	if utf8.RuneCountInString(r.Reason) > 512 {
		return fmt.Errorf("ban reason must be at most 512 characters")
	}
	if r.DurationSeconds != nil {
		if *r.DurationSeconds <= 0 {
			return fmt.Errorf("ban duration must be positive (omit field for permanent ban)")
		}
		if *r.DurationSeconds > maxBanDurationSeconds {
			return fmt.Errorf("ban duration cannot exceed 1 year")
		}
	}
	return nil
}

// ResolvedExpiresAt converts the optional duration into a wall-clock
// expiry the repo can store. Returns nil for permanent bans.
func (r *BanRequest) ResolvedExpiresAt() *time.Time {
	if r.DurationSeconds == nil {
		return nil
	}
	t := time.Now().UTC().Add(time.Duration(*r.DurationSeconds) * time.Second)
	return &t
}
