package models

import (
	"fmt"
	"strings"
	"time"
)

const SpamInboxLimit = 5000

func (e *SpamInboxEntry) Validate(record bool) error {
	if e == nil {
		return fmt.Errorf("missing spam reference")
	}
	if e.SourceKind != "channel" && e.SourceKind != "dm" && e.SourceKind != "group" {
		return fmt.Errorf("invalid spam source")
	}
	for _, id := range []string{e.ChannelID, e.MessageID} {
		if len(id) == 0 || len(id) > 128 || strings.TrimSpace(id) != id {
			return fmt.Errorf("invalid spam reference")
		}
	}
	if e.Revision != "original" {
		if len(e.Revision) > 64 {
			return fmt.Errorf("invalid revision")
		}
		if _, err := time.Parse(time.RFC3339Nano, e.Revision); err != nil {
			return fmt.Errorf("invalid revision")
		}
	}
	if record {
		if len(e.Reasons) == 0 || len(e.Reasons) > 3 {
			return fmt.Errorf("invalid spam reasons")
		}
		seen := map[string]bool{}
		for _, reason := range e.Reasons {
			if seen[reason] || (reason != "credential-link" && reason != "mass-mention-links" && reason != "repeated-links") {
				return fmt.Errorf("invalid spam reason")
			}
			seen[reason] = true
		}
	}
	return nil
}

type SpamInboxPage struct {
	Entries    []SpamInboxEntry `json:"entries"`
	NextCursor string           `json:"next_cursor,omitempty"`
}

// SpamInboxEntry stores recipient decisions, never decrypted message text.
type SpamInboxEntry struct {
	UserID      string   `json:"-"`
	SourceKind  string   `json:"source_kind"`
	ChannelID   string   `json:"channel_id"`
	MessageID   string   `json:"message_id"`
	Revision    string   `json:"revision"`
	Reasons     []string `json:"reasons"`
	Status      string   `json:"status"`
	CreatedAt   string   `json:"created_at"`
	Unavailable bool     `json:"unavailable,omitempty"`
	ServerID    string   `json:"server_id,omitempty"`
	AuthorID    string   `json:"author_id,omitempty"`
}
