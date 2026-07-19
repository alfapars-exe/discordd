package models

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"time"
)

// BotTokenPrefix tags every bot bearer credential so the auth middleware can
// cheaply distinguish a bot token from a JWT before any DB work.
const BotTokenPrefix = "hb_"

// BotToken is a long-lived bearer credential for a bot account. The plaintext
// secret is shown to the owner once at creation; only TokenHash is stored.
type BotToken struct {
	ID         string     `json:"id"`
	BotUserID  string     `json:"bot_user_id"`
	Name       *string    `json:"name,omitempty"`
	CreatedAt  time.Time  `json:"created_at"`
	LastUsedAt *time.Time `json:"last_used_at,omitempty"`
	RevokedAt  *time.Time `json:"revoked_at,omitempty"`
}

// GenerateBotToken returns (plaintext, sha256hex). 32 random bytes, base64url.
func GenerateBotToken() (token, hash string, err error) {
	buf := make([]byte, 32)
	if _, err = rand.Read(buf); err != nil {
		return "", "", err
	}
	token = BotTokenPrefix + base64.RawURLEncoding.EncodeToString(buf)
	return token, HashBotToken(token), nil
}

// HashBotToken is the at-rest representation: hex SHA-256 of the full token.
func HashBotToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// CreateBotRequest is the owner-facing payload to register a new bot.
type CreateBotRequest struct {
	Username    string `json:"username"` // 3-32 chars, same charset as humans
	DisplayName string `json:"display_name"`
}
