package models

const (
	ReminderSourceChannel   = "channel"
	ReminderSourceDM        = "dm"
	ReminderStatusScheduled = "scheduled"
	ReminderStatusDelivered = "delivered"
	ReminderStatusCancelled = "cancelled"
)

type MessageReminder struct {
	ID             string  `json:"id"`
	UserID         string  `json:"user_id"`
	SourceKind     string  `json:"source_kind"`
	ServerID       *string `json:"server_id"`
	ChannelID      string  `json:"channel_id"`
	MessageID      string  `json:"message_id"`
	DueAt          string  `json:"due_at"`
	Status         string  `json:"status"`
	NotificationID *string `json:"notification_id"`
	CreatedAt      string  `json:"created_at"`
	UpdatedAt      string  `json:"updated_at"`
	DeliveredAt    *string `json:"delivered_at"`
}

type CreateMessageReminderRequest struct {
	RequestID  string  `json:"request_id,omitempty"`
	SourceKind string  `json:"source_kind"`
	ServerID   *string `json:"server_id"`
	ChannelID  string  `json:"channel_id"`
	MessageID  string  `json:"message_id"`
	DueAt      string  `json:"due_at"`
}

type UpdateMessageReminderRequest struct {
	DueAt string `json:"due_at"`
}
