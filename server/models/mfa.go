package models

// MFARecord never crosses an API boundary. Even encrypted secrets and hashes
// are deliberately excluded from JSON serialization.
type MFARecord struct {
	Secret            string `json:"-"`
	PendingSecret     string `json:"-"`
	PendingID         string `json:"-"`
	PendingExpires    int64  `json:"-"`
	LastStep          int64  `json:"-"`
	RecoveryRemaining int    `json:"-"`
	RecoveryVersion   int64  `json:"-"`
}

type MFAStatus struct {
	Enabled           bool `json:"enabled"`
	RecoveryRemaining int  `json:"recovery_remaining"`
}

type MFASetup struct {
	SetupID   string `json:"setup_id"`
	Secret    string `json:"secret"`
	URI       string `json:"uri"`
	ExpiresAt int64  `json:"expires_at"`
}
