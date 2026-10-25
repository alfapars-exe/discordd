package models

// Inbox includes every notification. Ordinary DM messages already contribute
// through dm_reads, so the aggregate app badge must not count their rows twice.
type NotificationUnreadCounts struct {
	UnreadCount      int `json:"unread_count"`
	BadgeUnreadCount int `json:"badge_unread_count"`
}
