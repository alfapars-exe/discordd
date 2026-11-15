package models

// DMDeviceRoster exposes only current device IDs and opaque key revisions.
// Prekeys and public key material are deliberately absent from this read path.
type DMDeviceRoster struct {
	Version int                    `json:"version"`
	Members []DMDeviceRosterMember `json:"members"`
}
type DMDeviceRosterMember struct {
	UserID  string                    `json:"user_id"`
	Devices []DMDeviceRosterReference `json:"devices"`
}
type DMDeviceRosterReference struct {
	DeviceID    string `json:"device_id"`
	KeyRevision string `json:"key_revision"`
}
