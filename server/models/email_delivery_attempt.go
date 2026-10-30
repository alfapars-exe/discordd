package models

// Internal provider payload. Never serialize into user-facing diagnostics/logs.
type EmailDeliveryPayload struct {
	From    string `json:"from"`
	To      string `json:"to"`
	Subject string `json:"subject"`
	HTML    string `json:"html"`
}

type EmailDeliveryAttempt struct {
	Key            string
	Payload        EmailDeliveryPayload
	FirstAttemptMS int64
	ProviderID     string
	Outcome        string
}
