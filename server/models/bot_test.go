package models

import (
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
	if HashBotToken("hb_abc") != HashBotToken("hb_abc") {
		t.Fatal("hash must be deterministic")
	}
}
