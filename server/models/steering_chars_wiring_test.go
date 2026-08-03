package models

import "testing"

// spoofed carries U+202E RIGHT-TO-LEFT OVERRIDE. Every case below proves the
// character is REJECTED, not merely that pkg.ContainsSteeringChars itself
// works (that is covered in pkg/steering_chars_test.go) -- this file exists
// because pkg being correct proves nothing about whether a Validate() call
// site actually reached it.
const spoofed = "admin\u202E"

func strPtr(s string) *string { return &s }

func TestValidate_RejectsSteeringChars(t *testing.T) {
	t.Run("CreateUserRequest display_name", func(t *testing.T) {
		r := &CreateUserRequest{Username: "validuser", Password: "longenough123", DisplayName: spoofed}
		if err := r.Validate(); err == nil {
			t.Fatal("spoofed display_name should be rejected")
		}
		clean := &CreateUserRequest{Username: "validuser", Password: "longenough123", DisplayName: "Ayşe"}
		if err := clean.Validate(); err != nil {
			t.Fatalf("ordinary display_name must be accepted, got: %v", err)
		}
	})

	t.Run("UpdateProfileRequest display_name", func(t *testing.T) {
		r := &UpdateProfileRequest{DisplayName: strPtr(spoofed)}
		if err := r.Validate(); err == nil {
			t.Fatal("spoofed display_name should be rejected")
		}
	})

	t.Run("UpdateProfileRequest custom_status", func(t *testing.T) {
		r := &UpdateProfileRequest{CustomStatus: strPtr(spoofed)}
		if err := r.Validate(); err == nil {
			t.Fatal("spoofed custom_status should be rejected")
		}
	})

	t.Run("CreateChannelRequest name", func(t *testing.T) {
		r := &CreateChannelRequest{Name: spoofed, Type: "text"}
		if err := r.Validate(); err == nil {
			t.Fatal("spoofed channel name should be rejected")
		}
	})

	t.Run("UpdateChannelRequest name", func(t *testing.T) {
		r := &UpdateChannelRequest{Name: strPtr(spoofed)}
		if err := r.Validate(); err == nil {
			t.Fatal("spoofed channel name should be rejected")
		}
	})

	t.Run("CreateCategoryRequest name", func(t *testing.T) {
		r := &CreateCategoryRequest{Name: spoofed}
		if err := r.Validate(); err == nil {
			t.Fatal("spoofed category name should be rejected")
		}
	})

	t.Run("UpdateCategoryRequest name", func(t *testing.T) {
		r := &UpdateCategoryRequest{Name: strPtr(spoofed)}
		if err := r.Validate(); err == nil {
			t.Fatal("spoofed category name should be rejected")
		}
	})

	t.Run("CreateServerRequest name", func(t *testing.T) {
		r := &CreateServerRequest{Name: spoofed, HostType: "mqvi_hosted"}
		if err := r.Validate(); err == nil {
			t.Fatal("spoofed server name should be rejected")
		}
		clean := &CreateServerRequest{Name: "Genel Sunucu", HostType: "mqvi_hosted"}
		if err := clean.Validate(); err != nil {
			t.Fatalf("ordinary server name must be accepted, got: %v", err)
		}
	})

	t.Run("UpdateServerRequest name", func(t *testing.T) {
		r := &UpdateServerRequest{Name: strPtr(spoofed)}
		if err := r.Validate(); err == nil {
			t.Fatal("spoofed server name should be rejected")
		}
	})
}
