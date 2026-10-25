package models

type AuthSession struct {
	ID           string `json:"id"`
	UserID       string `json:"-"`
	TokenVersion int    `json:"-"`
	ClientType   string `json:"client_type"`
	UserAgent    string `json:"user_agent"`
	CreatedAt    int64  `json:"created_at"`
	LastActiveAt int64  `json:"last_active_at"`
	ExpiresAt    int64  `json:"expires_at"`
	Current      bool   `json:"current"`
}
