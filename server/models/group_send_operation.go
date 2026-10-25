package models

import "time"

func ValidGroupSendRequestID(key string) bool {
	if len(key) < 16 || len(key) > 128 {
		return false
	}
	for _, c := range key {
		if (c < 'a' || c > 'z') && (c < 'A' || c > 'Z') && (c < '0' || c > '9') && c != '-' && c != '_' {
			return false
		}
	}
	return true
}

// GroupSendOperation stores no plaintext, ciphertext, filenames or response
// snapshot. Replays must load the current message after checking membership.
type GroupSendOperation struct {
	GroupID       string    `json:"group_id"`
	UserID        string    `json:"-"`
	RequestID     string    `json:"request_id"`
	RequestHash   string    `json:"-"`
	MessageID     string    `json:"message_id"`
	FileCount     int       `json:"file_count"`
	Phase         string    `json:"phase"`
	FailedIndices []int     `json:"failed_indices"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

type GroupSendOutcome struct {
	Operation *GroupSendOperation `json:"operation"`
	Message   *GroupDMMessage     `json:"message,omitempty"`
}
