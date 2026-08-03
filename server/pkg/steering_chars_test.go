package pkg

import "testing"

// As with filename_test.go, every case here writes invisible characters as
// \u escapes and never as literals -- a literal U+202E would reorder this
// file for anyone viewing the diff.
func TestContainsSteeringChars(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want bool
	}{
		// ── ordinary text: must pass ──────────────────────────────────
		{"ascii", "Zeynep", false},
		{"turkish", "Ayşe Öztürk", false},
		{"cyrillic", "Зейнеп", false},
		{"cjk", "田中太郎", false},
		{"emoji", "Zeynep 🎉", false},
		{"inner spaces", "General Chat", false},
		{"empty", "", false},

		// ── plain-text sinks: control characters ──────────────────────
		{"nul byte", "a\u0000b", true},
		{"crlf", "a\r\nb", true},
		{"escape char", "a\u001bb", true},
		{"del", "a\u007fb", true},
		{"c1 control", "a\u009bb", true},

		// ── display spoofing: the reason this exists ───────────────────
		{"rtl override", "admin\u202E", true},
		{"lrm/rlm marks", "a\u200Eb\u200Fc", true},
		{"bidi isolates", "\u2066a\u2069", true},
		{"zero width space", "adm\u200Bin", true},
		{"zero width joiner", "adm\u200Din", true},
		{"soft hyphen", "ad\u00admin", true},
		{"bom", "\ufeffadmin", true},
		{"line separator", "a\u2028b", true},
		{"paragraph separator", "a\u2029b", true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := ContainsSteeringChars(tc.in); got != tc.want {
				t.Errorf("ContainsSteeringChars(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}
