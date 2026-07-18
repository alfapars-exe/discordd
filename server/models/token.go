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
// Scope (claim "scope") narrows what a token may be used for.
//
// Empty scope = full API access token: the only kind accepted by
// AuthMiddleware.Require and the WebSocket upgrade path.
//
// TokenScopeMedia = media-only token: accepted ONLY by
// handlers.UploadDownloadHandler for GET /api/uploads/*. It rides in the
// hichat_media cookie, which — being a cookie — is attached automatically
// to cross-site subresource loads and therefore has a materially larger
// exposure surface than a header-borne token. Scoping it means a leaked
// media cookie cannot be replayed as `Authorization: Bearer` against the
// API or as `?token=` against the WebSocket; it can only re-fetch
// attachments the user was already permitted to see.
//
// Omitted (empty) in every token issued before the scope claim existed.
// Those legacy tokens keep working everywhere until they expire — see the
// empty-scope allowance in UploadDownloadHandler.authUserID.
type TokenClaims struct {
	UserID       string `json:"user_id"`
	Username     string `json:"username"`
	TokenVersion int    `json:"tv,omitempty"`
	Scope        string `json:"scope,omitempty"`
	jwt.RegisteredClaims
}

// TokenScopeMedia marks a token that may only authenticate media downloads
// (GET /api/uploads/*). See the Scope field doc above.
const TokenScopeMedia = "media"
