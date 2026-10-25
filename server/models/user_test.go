package models

import "testing"

func TestCreateUserRequest_Validate_EmailRequired(t *testing.T) {
	r := &CreateUserRequest{Username: "validuser", Password: "longenough123"}
	if err := r.Validate(); err == nil {
		t.Fatal("blank email must be rejected")
	}
}

func TestCreateUserRequest_Validate_RejectsMalformedNonEmptyEmail(t *testing.T) {
	// Proves the fix isn't "email checking removed entirely" — a non-empty
	// but malformed email must still fail.
	r := &CreateUserRequest{Username: "validuser", Password: "longenough123", Email: "not-an-email"}
	if err := r.Validate(); err == nil {
		t.Fatal("malformed non-empty email should still be rejected")
	}
}

func TestCreateUserRequest_Validate_AcceptsWellFormedEmail(t *testing.T) {
	r := &CreateUserRequest{Username: "validuser", Password: "longenough123", Email: "user@example.com"}
	if err := r.Validate(); err != nil {
		t.Fatalf("well-formed email must be accepted, got: %v", err)
	}
}
