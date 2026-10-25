package models

import "time"

type DataExportJob struct {
	ID        string    `json:"id"`
	Status    string    `json:"status"`
	ErrorCode *string   `json:"error_code,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	ExpiresAt time.Time `json:"expires_at"`
}
