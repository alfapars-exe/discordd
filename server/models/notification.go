package models

import "encoding/json"

// Notification kinds — must stay in sync with the CHECK constraint in
// database/migrations/082_notifications.sql.
const (
	NotificationKindMention       = "mention"
	NotificationKindReply         = "reply"
	NotificationKindFriendRequest = "friend_request"
	NotificationKindDMRequest     = "dm_request"
	// NotificationKindSystem is reserved: the schema accepts it but nothing
	// writes it in this phase.
	NotificationKindSystem = "system"
)

// Notification is one inbox row (notifications table). The DB stores
// created_at/read_at as 'YYYY-MM-DD HH:MM:SS' UTC text; the repository
// converts them to RFC3339 ('...T...Z') on the way out so browsers parse
// them as UTC. They stay strings (not time.Time) because the keyset cursor
// is resolved SQL-side against the raw stored column.
//
// Payload keys by kind:
//
//	mention | reply   : {"preview": string|null, "channel_name": string}
//	friend_request    : {"friendship_id": string}
//	dm_request        : {}
//	system            : {"title": string, "body": string}
//
// Actor is the LEFT JOINed public view of actor_id — nil when the actor
// was deleted (or the row has no actor).
type Notification struct {
	ID               string          `json:"id"`
	UserID           string          `json:"user_id"`
	Kind             string          `json:"kind"`
	ActorID          *string         `json:"actor_id"`
	Actor            *PublicUser     `json:"actor"`
	ServerID         *string         `json:"server_id"`
	ChannelID        *string         `json:"channel_id"`
	MessageID        *string         `json:"message_id"`
	DMChannelID      *string         `json:"dm_channel_id"`
	GroupDMChannelID *string         `json:"group_dm_channel_id,omitempty"`
	Payload          json.RawMessage `json:"payload"`
	ReadAt           *string         `json:"read_at"`
	CreatedAt        string          `json:"created_at"`
}

// NotificationPage is the GET /api/users/me/notifications response.
type NotificationPage struct {
	Notifications []Notification `json:"notifications"`
	HasMore       bool           `json:"has_more"`
}
