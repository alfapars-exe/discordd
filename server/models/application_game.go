package models

import "time"

// ApplicationGameIdentity describes a registered type; it asserts no verified
// ownership, publisher trust, or first-party affiliation.
type ApplicationGameIdentity struct {
	ApplicationID     string `json:"application_id"`
	IsGameApplication bool   `json:"is_game_application"`
}

type ApplicationGameGrant struct {
	ApplicationID       string     `json:"application_id"`
	ApplicationName     string     `json:"application_name"`
	ApplicationUsername string     `json:"application_username"`
	MessagingEnabled    bool       `json:"messaging_enabled"`
	Revision            int64      `json:"revision"`
	AuthorizedAt        time.Time  `json:"authorized_at"`
	UpdatedAt           time.Time  `json:"updated_at"`
	RevokedAt           *time.Time `json:"revoked_at,omitempty"`
}
