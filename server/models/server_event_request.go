package models

// CreateServerEventRequest contains the mutable event fields accepted when a
// server manager creates an event. Validation is performed by the service so
// all entry points share the same authorization and bounds.
type CreateServerEventRequest struct {
	Name        string  `json:"name"`
	Description string  `json:"description"`
	StartsAt    string  `json:"starts_at"`
	EndsAt      *string `json:"ends_at,omitempty"`
	ChannelID   *string `json:"channel_id,omitempty"`
}

// UpdateServerEventRequest replaces the mutable event fields and requires the
// version read by the caller for compare-and-swap updates.
type UpdateServerEventRequest struct {
	Name            string  `json:"name"`
	Description     string  `json:"description"`
	StartsAt        string  `json:"starts_at"`
	EndsAt          *string `json:"ends_at,omitempty"`
	ChannelID       *string `json:"channel_id,omitempty"`
	ExpectedVersion int64   `json:"expected_version"`
}
