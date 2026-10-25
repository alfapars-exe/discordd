package i18n

import (
	"testing"
	"testing/fstest"
)

func TestI18n(t *testing.T) {
	mockFS := fstest.MapFS{
		"en.json": &fstest.MapFile{
			Data: []byte(`{
				"greeting": "Hello",
				"welcome": "Welcome {{name}}!",
				"auth": {
					"login": "Log in",
					"logout": "Log out"
				}
			}`),
		},
		"tr.json": &fstest.MapFile{
			Data: []byte(`{
				"greeting": "Merhaba",
				"welcome": "Hoş geldin {{name}}!",
				"auth": {
					"login": "Giriş yap"
				}
			}`),
		},
	}

	if err := Load(mockFS); err != nil {
		t.Fatalf("Load failed: %v", err)
	}

	// TR localizer
	trLoc := NewLocalizer("tr")
	if trLoc.T("greeting") != "Merhaba" {
		t.Errorf("expected Merhaba, got %s", trLoc.T("greeting"))
	}
	if trLoc.T("auth.login") != "Giriş yap" {
		t.Errorf("expected Giriş yap, got %s", trLoc.T("auth.login"))
	}
	// Fallback to English when key missing in TR
	if trLoc.T("auth.logout") != "Log out" {
		t.Errorf("expected fallback 'Log out', got %s", trLoc.T("auth.logout"))
	}
	// Key missing in both returns key
	if trLoc.T("non.existent") != "non.existent" {
		t.Errorf("expected key itself, got %s", trLoc.T("non.existent"))
	}

	// TWithParams
	msg := trLoc.TWithParams("welcome", map[string]string{"name": "Ali"})
	if msg != "Hoş geldin Ali!" {
		t.Errorf("expected 'Hoş geldin Ali!', got %s", msg)
	}

	// Default fallback for unknown lang
	unkLoc := NewLocalizer("fr")
	if unkLoc.lang != DefaultLanguage {
		t.Errorf("expected default lang, got %s", unkLoc.lang)
	}
}

func TestDetectLanguage(t *testing.T) {
	tests := []struct {
		header   string
		expected string
	}{
		{"", "en"},
		{"tr-TR,tr;q=0.9,en;q=0.8", "tr"},
		{"en-US,en;q=0.5", "en"},
		{"fr-FR,fr;q=0.9", "en"},
		{"TR", "tr"},
	}

	for _, tt := range tests {
		got := DetectLanguage(tt.header)
		if got != tt.expected {
			t.Errorf("DetectLanguage(%q) = %q, want %q", tt.header, got, tt.expected)
		}
	}
}
