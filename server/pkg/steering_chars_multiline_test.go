package pkg

import "testing"

func TestContainsSteeringCharsMultiline(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want bool
	}{
		{"plain", "remember to ask about the deploy", false},
		{"newline is allowed", "line one\nline two", false},
		{"tab is allowed", "col1\tcol2", false},
		{"non-ascii passes", "Zeynep 🎉 Зейнеп\nikinci satır", false},
		{"carriage return is still rejected", "a\r\nb", true},
		{"bidi override is rejected", "safe\u202eevil", true},
		{"zero width space is rejected", "zero\u200bwidth", true},
		{"other C0 control is rejected", "bell\x07", true},
		{"line separator is rejected", "a b", true},
		{"empty", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ContainsSteeringCharsMultiline(tc.in); got != tc.want {
				t.Errorf("ContainsSteeringCharsMultiline(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

// TestContainsSteeringCharsMultiline_StricterThanSingleLineOnlyForNewlines
// pins the relationship to ContainsSteeringChars: the multi-line variant
// accepts a strict superset (newline/tab) and nothing else.
func TestContainsSteeringCharsMultiline_StricterThanSingleLineOnlyForNewlines(t *testing.T) {
	if !ContainsSteeringChars("a\nb") || ContainsSteeringCharsMultiline("a\nb") {
		t.Error("newline must be rejected by the single-line check and accepted by the multi-line one")
	}
	if !ContainsSteeringChars("a\u202eb") || !ContainsSteeringCharsMultiline("a\u202eb") {
		t.Error("a bidi override must be rejected by both checks")
	}
}
