package models

// LogLevel represents severity of a log entry.
type LogLevel string

const (
	LogLevelError LogLevel = "error"
	LogLevelWarn  LogLevel = "warn"
	LogLevelInfo  LogLevel = "info"
)

// LogCategory represents the subsystem that produced the log.
type LogCategory string

const (
	LogCategoryVoice       LogCategory = "voice"
	LogCategoryVideo       LogCategory = "video"
	LogCategoryScreenShare LogCategory = "screen_share"
	LogCategoryWS          LogCategory = "ws"
	LogCategoryAuth        LogCategory = "auth"
	LogCategoryGeneral     LogCategory = "general"
	LogCategoryFeedback    LogCategory = "feedback"
	LogCategoryLiveKit     LogCategory = "livekit"
	LogCategoryClient      LogCategory = "client"
)

// AppLog represents a structured log entry stored in SQLite.
// Username/DisplayName are resolved via LEFT JOIN at query time — not stored.
type AppLog struct {
	ID              string      `json:"id"`
	Level           LogLevel    `json:"level"`
	Category        LogCategory `json:"category"`
	UserID          *string     `json:"user_id"`
	ServerID        *string     `json:"server_id"`
	Message         string      `json:"message"`
	Metadata        string      `json:"metadata"`
	CreatedAt       string      `json:"created_at"`
	Username        *string     `json:"username"`
	DisplayName     *string     `json:"display_name"`
	RequestID       string      `json:"request_id"`
	EventCode       string      `json:"event_code"`
	Component       string      `json:"component"`
	ErrorKind       string      `json:"error_kind"`
	OccurrenceCount int64       `json:"occurrence_count"`
	LastSeenAt      string      `json:"last_seen_at"`
}

// AppLogFilter defines query parameters for listing logs.
type AppLogFilter struct {
	Level     string `json:"level"`
	Category  string `json:"category"`
	Search    string `json:"search"`
	Limit     int    `json:"limit"`
	Offset    int    `json:"offset"`
	RequestID string `json:"request_id"`
	EventCode string `json:"event_code"`
	Component string `json:"component"`
	From      string `json:"from"`
	To        string `json:"to"`
}

type AppLogHealth struct {
	ErrorQueue      int    `json:"error_queue"`
	NormalQueue     int    `json:"normal_queue"`
	ErrorCapacity   int    `json:"error_capacity"`
	NormalCapacity  int    `json:"normal_capacity"`
	DroppedError    uint64 `json:"dropped_error"`
	DroppedWarn     uint64 `json:"dropped_warn"`
	DroppedInfo     uint64 `json:"dropped_info"`
	WriteFailures   uint64 `json:"write_failures"`
	FailedEvents    uint64 `json:"failed_events"`
	ExcludedDeleted uint64 `json:"excluded_deleted"`
	GroupedEvents   uint64 `json:"grouped_events"`
	LastSuccessAt   string `json:"last_success_at"`
	RetentionDays   int    `json:"retention_days"`
}
