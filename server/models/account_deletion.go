package models

type AccountOwnedResource struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
	Name string `json:"name"`
}
type AccountDeletionStatus struct {
	PlatformAdmin bool                   `json:"platform_admin"`
	OwnedCount    int                    `json:"owned_count"`
	Resources     []AccountOwnedResource `json:"resources"`
	NextOffset    *int                   `json:"next_offset"`
	CheckedAt     int64                  `json:"checked_at"`
}
