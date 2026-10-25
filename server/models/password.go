package models

import (
	"fmt"
	"unicode/utf8"
)

// ValidateNewPassword is shared by registration, change and recovery. Count
// Unicode code points for the minimum, but bound UTF-8 bytes for bcrypt.
// Never apply this policy to an existing password during authentication.
func ValidateNewPassword(password string) error {
	if !utf8.ValidString(password) {
		return fmt.Errorf("password must be valid UTF-8")
	}
	if utf8.RuneCountInString(password) < 8 {
		return fmt.Errorf("password must be at least 8 characters")
	}
	if len(password) > 72 {
		return fmt.Errorf("password must be at most 72 UTF-8 bytes")
	}
	return nil
}
