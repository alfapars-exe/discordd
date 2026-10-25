package models

type ClipConsentSnapshot struct {
	RecordingID     string   `json:"recording_id,omitempty"`
	IncludedUserIDs []string `json:"included_user_ids"`
	ExcludedUserIDs []string `json:"excluded_user_ids"`
}

type StartClipRecordingRequest struct {
	ChannelID string `json:"channel_id"`
}

type StopClipRecordingRequest struct {
	ChannelID  string `json:"channel_id"`
	DurationMS int64  `json:"duration_ms"`
}
