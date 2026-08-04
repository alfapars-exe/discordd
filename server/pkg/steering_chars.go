package pkg

import "unicode"

// ContainsSteeringChars reports whether s contains a rune that changes how
// the string is *interpreted* by a renderer rather than how it reads: C0/C1
// control characters and DEL, the Unicode format characters (bidi
// embeddings/overrides/isolates, zero-width marks, soft hyphen, BOM), or the
// line and paragraph separators.
//
// This is the identity-field counterpart to SanitizeFilename, and exists for
// the same reason: every one of these fields — display name, custom status,
// channel/category/server/badge/soundboard name — is rendered verbatim next
// to other people's names in a member list, a channel sidebar, or a message.
// React escapes HTML; it does not neutralise a bidi override. A display name
// carrying U+202E can present as a completely different string than the one
// stored, which is a spoofing vector in exactly the places identity is meant
// to be trustworthy — a member list, a mention autocomplete, an admin log.
//
// Unlike SanitizeFilename, which silently strips these characters from a
// server-generated name, identity fields reject on ContainsSteeringChars:
// silently rewriting what a person typed as their name is its own kind of
// surprise, and the existing convention for these fields (see
// isValidUsernameChar) is already reject-not-rewrite.
//
// Ordinary non-ASCII is untouched: "Zeynep", "Zeynep 🎉", and "Зейнеп" all
// pass. Only characters that render as nothing on their own, or that change
// the rendering of characters around them, trip this check.
func ContainsSteeringChars(s string) bool {
	for _, r := range s {
		if isSteeringChar(r) {
			return true
		}
	}
	return false
}

func isSteeringChar(r rune) bool {
	switch {
	case unicode.IsControl(r):
		// Cc: C0 (NUL, CR, LF, ESC, ...), DEL, and C1.
		return true
	case unicode.Is(unicode.Cf, r):
		// Cf: bidi embedding/override/isolate, zero-width joiner and
		// non-joiner, word joiner, soft hyphen, BOM.
		return true
	case r == '\u2028' || r == '\u2029':
		// Zl / Zp — not control characters by category, but they end a
		// line in enough renderers to deserve the same treatment.
		return true
	}
	return false
}
