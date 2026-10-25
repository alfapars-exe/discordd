package models

type AccountRestriction struct {
	Kind       string `json:"kind"`
	ServerID   string `json:"server_id"`
	ServerName string `json:"server_name"`
	Reason     string `json:"reason"`
	CreatedAt  int64  `json:"created_at"`
	ExpiresAt  *int64 `json:"expires_at"`
}

type AccountStatus struct {
	PlatformBanned bool                 `json:"platform_banned"`
	PlatformReason string               `json:"platform_reason,omitempty"`
	CheckedAt      int64                `json:"checked_at"`
	Restrictions   []AccountRestriction `json:"restrictions"`
	NextOffset     *int                 `json:"next_offset"`
}
