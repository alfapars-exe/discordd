package models

import (
	"fmt"
	"strings"
	"time"
)

// PasswordResetToken — only the SHA256 hash is stored; plaintext is sent via email.
// If DB is compromised, tokens remain unusable.
type PasswordResetToken struct {
	ID        string    `json:"id"`
	UserID    string    `json:"user_id"`
	TokenHash string    `json:"token_hash"`
	ExpiresAt time.Time `json:"expires_at"`
	CreatedAt time.Time `json:"created_at"`
}

type ForgotPasswordRequest struct {
	Identifier string `json:"identifier"`
}

func (r *ForgotPasswordRequest) Validate() error {
	r.Identifier = strings.TrimSpace(r.Identifier)
	if r.Identifier == "" {
		return fmt.Errorf("username or email is required")
	}
	return nil
}

type ResetPasswordRequest struct {
	Token       string `json:"token"`
	NewPassword string `json:"new_password"`
}

func (r *ResetPasswordRequest) Validate() error {
	if r.Token == "" {
		return fmt.Errorf("token is required")
	}
	if r.NewPassword == "" {
		return fmt.Errorf("new password is required")
	}
	return ValidateNewPassword(r.NewPassword)
}
