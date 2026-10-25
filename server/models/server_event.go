package models

// ServerEventStatus describes whether an event may still be joined or
// notified. Events are server-wide; ChannelID is an optional related channel,
// whose visibility must be checked by the service before it is returned.
const (
	ServerEventStatusScheduled = "scheduled"
	ServerEventStatusCancelled = "cancelled"
)

// ServerEvent is the persisted, server-scoped event contract. Times are
// RFC3339 UTC strings at the API boundary.
type ServerEvent struct {
	ID          string  `json:"id"`
	ServerID    string  `json:"server_id"`
	CreatorID   string  `json:"creator_id"`
	Name        string  `json:"name"`
	Description string  `json:"description"`
	StartsAt    string  `json:"starts_at"`
	EndsAt      *string `json:"ends_at,omitempty"`
	ChannelID   *string `json:"channel_id,omitempty"`
	Status      string  `json:"status"`
	Version     int64   `json:"version"`
	Interested  bool    `json:"interested"`
	CreatedAt   string  `json:"created_at"`
	UpdatedAt   string  `json:"updated_at"`
}
