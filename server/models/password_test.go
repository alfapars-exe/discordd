package models

import (
	"strings"
	"testing"
)

func TestNewPasswordPolicyAcrossRequests(t *testing.T) {
	for _, tc := range []struct {
		name, password string
		valid          bool
	}{
		{"short ascii", "1234567", false},
		{"short unicode", strings.Repeat("ş", 7), false},
		{"eight emoji", strings.Repeat("😀", 8), true},
		{"bcrypt boundary", strings.Repeat("a", 72), true},
		{"bcrypt overflow", strings.Repeat("a", 73), false},
		{"unicode boundary", strings.Repeat("😀", 18), true},
		{"unicode overflow", strings.Repeat("😀", 19), false},
		{"not trimmed", "        ", true},
		{"invalid utf8", "abcdefgh\xff", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			registration := CreateUserRequest{Username: "valid_user", Password: tc.password, Email: "test@example.com"}
			recovery := ResetPasswordRequest{Token: "token", NewPassword: tc.password}
			for name, err := range map[string]error{"policy": ValidateNewPassword(tc.password), "registration": registration.Validate(), "recovery": recovery.Validate()} {
				if (err == nil) != tc.valid {
					t.Errorf("%s: valid=%v, err=%v", name, tc.valid, err)
				}
			}
		})
	}
}
