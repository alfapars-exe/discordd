package models

import (
	"fmt"
	"time"
)

// MuteForeverSentinel is used as a datetime value that is always in the future.
// SQLite: WHERE muted_until > datetime('now') will always include this.
// "YYYY-MM-DD HH:MM:SS" (no 'T'/'Z') to match every other muted_until write
// (see ParseMutedUntil below) — the sentinel would have compared correctly
// either way (its "9999" year prefix already sorts after any real 'now'
// output regardless of separator), but a single column holding two
// different datetime shapes was still worth collapsing to one for anyone
// reading the raw column value directly (admin queries, migration 077).
const MuteForeverSentinel = "9999-12-31 23:59:59"

type DMSettings struct {
	UserID      string     `json:"user_id"`
	DMChannelID string     `json:"dm_channel_id"`
	IsHidden    bool       `json:"is_hidden"`
	IsPinned    bool       `json:"is_pinned"`
	MutedUntil  *time.Time `json:"muted_until"` // nil = not muted
	CreatedAt   time.Time  `json:"created_at"`
}

type MuteDMRequest struct {
	Duration string `json:"duration"` // "1h", "8h", "7d", "forever"
}

var validDMDurations = map[string]time.Duration{
	"1h":      1 * time.Hour,
	"8h":      8 * time.Hour,
	"7d":      7 * 24 * time.Hour,
	"forever": 0,
}

func (r *MuteDMRequest) Validate() error {
	if _, ok := validDMDurations[r.Duration]; !ok {
		return fmt.Errorf("invalid duration: %s", r.Duration)
	}
	return nil
}

// ParseMutedUntil converts the duration string to a DB-ready *string.
// "forever" → sentinel, others → now + duration.
//
// Pre-formatted "YYYY-MM-DD HH:MM:SS", NOT time.RFC3339 ("...T...Z"): the
// repository compares this value against sqlite's datetime('now') output
// (sqlite_dm_settings.go / sqlite_dm_channels.go), and an RFC3339 string
// sorts lexically AFTER that output because 'T' > ' ' — so an already-past
// mute would still read as active. Same bug class as go-libsql's raw
// time.Time binding; see sqlite_ban.go for the reference fix.
func (r *MuteDMRequest) ParseMutedUntil() *string {
	d := validDMDurations[r.Duration]
	if d == 0 {
		s := MuteForeverSentinel
		return &s
	}
	t := time.Now().UTC().Add(d).Format("2006-01-02 15:04:05")
	return &t
}
