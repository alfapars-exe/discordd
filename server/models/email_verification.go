package models

type EmailVerificationStatus struct {
	Email             *string `json:"email"`
	Generation        int64   `json:"generation"`
	Verified          bool    `json:"verified"`
	VerifiedAt        *int64  `json:"verified_at"`
	DeliveryAvailable bool    `json:"delivery_available"`
	RetryAfter        int64   `json:"retry_after"`
}
