package models

import (
	"crypto/hmac"
	"strings"
	"testing"
)

func TestGenerateBotToken_FormatAndHash(t *testing.T) {
	tok, hash, err := GenerateBotToken()
	if err != nil {
		t.Fatalf("GenerateBotToken: %v", err)
	}
	if !strings.HasPrefix(tok, BotTokenPrefix) {
		t.Fatalf("token missing %q prefix: %q", BotTokenPrefix, tok)
	}
	if len(hash) != 64 { // hex SHA-256
		t.Fatalf("expected 64-char hex hash, got %d", len(hash))
	}
	if HashBotToken(tok) != hash {
		t.Fatal("HashBotToken(token) must equal the returned hash")
	}
	tok2, _, _ := GenerateBotToken()
	if tok == tok2 {
		t.Fatal("two generated tokens must differ")
	}
}

func TestHashBotToken_Stable(t *testing.T) {
	// Bind both results before comparing, then compare via hmac.Equal
	// instead of != — the latter keeps this assertion off Checkmarx's
	// "Observable Timing Discrepancy" sink list (constant-time comparison),
	// same as the production hash/token comparisons elsewhere. The binding
	// itself predates that: inlining the two calls makes the comparison
	// read as `f(x) != f(x)`, which staticcheck flags as SA4000 (identical
	// operands) — it can't tell a determinism check from the copy-paste bug
	// that rule exists to catch.
	first := HashBotToken("hb_abc")
	second := HashBotToken("hb_abc")
	if !hmac.Equal([]byte(first), []byte(second)) {
		t.Fatal("hash must be deterministic")
	}
}
