package pkg

import "testing"

// The whole point of this function is characters you cannot see, so every
// case below writes them as \u escapes and the test names say what they
// are. A literal in this file would be unreviewable in a diff.
func TestSanitizeFilename(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		// ── containment ──────────────────────────────────────────────
		{"posix traversal", "../../etc/passwd", "passwd"},
		{"windows traversal", `..\..\evil.png`, "evil.png"},
		// filepath.Base would answer these differently on Windows and on
		// Linux (POSIX does not treat a backslash as a separator), which is
		// exactly the divergence that turned CI red while the same test
		// passed locally. SanitizeFilename cuts at either separator itself,
		// so these expectations hold on every platform.
		{"windows absolute path", `C:\Users\me\photo.png`, "photo.png"},
		{"unc path", `\\server\share\x.png`, "x.png"},
		{"mixed separators", `a/b\c/d.png`, "d.png"},
		{"trailing separator", "a/b/", "unnamed"},
		{"bare dotdot", "..", "unnamed"},
		{"bare dot", ".", "unnamed"},
		{"empty", "", "unnamed"},
		{"nul byte", "evil\u0000.png", "evil.png"},

		// ── plain-text sinks (the feedback app-log stores these) ──────
		{"crlf forges a log line", "a\r\nDELETE FROM users.pdf", "aDELETE FROM users.pdf"},
		{"escape char", "sheet\u001b[2J.csv", "sheet[2J.csv"},
		{"del", "note\u007f.txt", "note.txt"},
		{"c1 control", "note\u009b.txt", "note.txt"},

		// ── display spoofing: the reason this is not just a disk helper ──
		// U+202E RIGHT-TO-LEFT OVERRIDE makes the tail render reversed,
		// so "gnp.exe" reads as "exe.png" and an executable looks like an
		// image to the person about to click it.
		{"rtl override", "fatura\u202Egnp.exe", "faturagnp.exe"},
		{"lrm/rlm marks", "a\u200Eb\u200Fc.png", "abc.png"},
		{"bidi isolates", "\u2066a\u2069.png", "a.png"},
		{"zero width space", "photo\u200B.png", "photo.png"},
		{"zero width joiner", "photo\u200D.png", "photo.png"},
		{"soft hyphen", "in\u00advoice.pdf", "invoice.pdf"},
		{"bom", "\ufeffdoc.pdf", "doc.pdf"},
		{"line separator", "a\u2028b.txt", "ab.txt"},
		{"paragraph separator", "a\u2029b.txt", "ab.txt"},
		{"nothing but an override", "\u202E", "unnamed"},

		// ── must survive: these are ordinary names ───────────────────
		{"ascii", "belge.pdf", "belge.pdf"},
		{"turkish", "fatura-ocak-2026-ç.pdf", "fatura-ocak-2026-ç.pdf"},
		{"cyrillic", "документ.pdf", "документ.pdf"},
		{"cjk", "写真.jpg", "写真.jpg"},
		{"emoji", "party🎉.png", "party🎉.png"},
		{"inner spaces", "my holiday photo.jpeg", "my holiday photo.jpeg"},
		{"leading/trailing space trimmed", "  report.pdf  ", "report.pdf"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := SanitizeFilename(tc.in); got != tc.want {
				t.Errorf("SanitizeFilename(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// The output feeds both a filesystem path and a rendered label, so assert
// the class-level guarantee directly rather than only through examples:
// nothing that steers a path or a renderer may survive any input.
func TestSanitizeFilename_outputCarriesNoSteeringChars(t *testing.T) {
	inputs := []string{
		"../../etc/passwd",
		"a\r\nb",
		"fatura\u202Egnp.exe",
		"\u2066\u2067\u2068\u2069",
		"x\u0000\u001b\u007f\u009b\u200b\ufeff\u2028\u2029y",
		"документ.pdf",
	}
	for _, in := range inputs {
		got := SanitizeFilename(in)
		for _, r := range got {
			switch {
			case r == '/' || r == '\\':
				t.Errorf("SanitizeFilename(%q) = %q: kept separator %q", in, got, r)
			case r < 0x20 || r == 0x7f || (r >= 0x80 && r <= 0x9f):
				t.Errorf("SanitizeFilename(%q) = %q: kept control U+%04X", in, got, r)
			case r == '\u2028' || r == '\u2029':
				t.Errorf("SanitizeFilename(%q) = %q: kept separator U+%04X", in, got, r)
			}
		}
		if got == "" {
			t.Errorf("SanitizeFilename(%q) returned empty; want a fallback", in)
		}
	}
}

// Idempotence matters because the same name passes through the sanitizer on
// upload and again on any later re-derivation; a second pass must be a no-op.
func TestSanitizeFilename_idempotent(t *testing.T) {
	for _, in := range []string{"../../etc/passwd", "fatura\u202Egnp.exe", "документ.pdf", "..", ""} {
		once := SanitizeFilename(in)
		if twice := SanitizeFilename(once); twice != once {
			t.Errorf("not idempotent for %q: %q then %q", in, once, twice)
		}
	}
}
