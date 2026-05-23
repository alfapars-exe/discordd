package models

import (
	"fmt"
	"time"
	"unicode/utf8"
)

// MemberTimeout — Discord-style timeout. The user stays in the server
// but is blocked from sending messages, adding reactions, and joining
// voice channels until ExpiresAt. Service layer checks the row on the
// hot paths; expired rows are filtered out by the repo, so no cleanup
// job is needed.
type MemberTimeout struct {
	ServerID  string    `json:"server_id"`
	UserID    string    `json:"user_id"`
	ExpiresAt time.Time `json:"expires_at"`
	AppliedBy string    `json:"applied_by"`
	Reason    string    `json:"reason"`
	CreatedAt time.Time `json:"created_at"`
}

// TimeoutRequest — body for `PUT /api/servers/{id}/members/{uid}/timeout`.
// DurationSeconds is required (>0) — un-timeout uses DELETE on the same
// route, not a zero-duration request, so we can validate strictly.
// Cap matches Discord's 28-day max for parity (and to keep the UI's
// preset list reasonable).
type TimeoutRequest struct {
	DurationSeconds int64  `json:"duration_seconds"`
	Reason          string `json:"reason"`
}

const maxTimeoutDurationSeconds = 28 * 24 * 60 * 60 // 28 days, Discord-parity

func (r *TimeoutRequest) Validate() error {
	if r.DurationSeconds <= 0 {
		return fmt.Errorf("timeout duration must be positive")
	}
	if r.DurationSeconds > maxTimeoutDurationSeconds {
		return fmt.Errorf("timeout duration cannot exceed 28 days")
	}
	if utf8.RuneCountInString(r.Reason) > 512 {
		return fmt.Errorf("timeout reason must be at most 512 characters")
	}
	return nil
}

// ExpiresAt converts the duration into a wall-clock expiry.
func (r *TimeoutRequest) ExpiresAt() time.Time {
	return time.Now().UTC().Add(time.Duration(r.DurationSeconds) * time.Second)
}
