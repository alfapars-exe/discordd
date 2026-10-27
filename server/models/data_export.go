package models

import "time"

type DataExportJob struct {
	ID                string    `json:"id"`
	Status            string    `json:"status"`
	ErrorCode         *string   `json:"error_code,omitempty"`
	CreatedAt         time.Time `json:"created_at"`
	ExpiresAt         time.Time `json:"expires_at"`
	AttachmentsReady  bool      `json:"attachments_ready"`
	AttachmentsStatus string    `json:"attachments_status"`
	AttachmentsError  *string   `json:"attachments_error,omitempty"`
}
