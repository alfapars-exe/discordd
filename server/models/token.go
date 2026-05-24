package models

import "github.com/golang-jwt/jwt/v5"

// TokenClaims — JWT payload. Defined in models to avoid circular deps
// between services, ws, and middleware.
//
// TokenVersion (claim "tv") is the user's revocation counter at the time
// the token was issued. ValidateAccessToken compares it against the
// current users.token_version row — a mismatch means the user invoked
// "logout from all devices" after issuance and the token must be rejected.
// Omitted (zero) in tokens issued before migration 066; those are treated
// as tv=0 against the default users.token_version=0 so legacy tokens
// continue to validate until they expire naturally.
type TokenClaims struct {
	UserID       string `json:"user_id"`
	Username     string `json:"username"`
	TokenVersion int    `json:"tv,omitempty"`
	jwt.RegisteredClaims
}
