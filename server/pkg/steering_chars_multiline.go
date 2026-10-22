package pkg

import "strings"

// ContainsSteeringCharsMultiline is ContainsSteeringChars for free-text
// fields that legitimately span lines — saved-message notes and per-user
// notes — where '\n' (a line break) and '\t' (a tab) are the two control
// characters a multi-line text box produces on purpose. Those two are
// exempted; everything else ContainsSteeringChars rejects (bidi
// embeddings/overrides, zero-width marks, the remaining C0/C1 controls,
// line/paragraph separators) is just as much a spoofing vector in a note
// that renders next to a message as it is in a display name.
//
// '\r' is deliberately NOT exempted: callers normalise CRLF to LF (strip
// every "\r") BEFORE validating, so a lone carriage return reaching this
// check is a stray control character, not a line ending.
func ContainsSteeringCharsMultiline(s string) bool {
	return ContainsSteeringChars(strings.NewReplacer("\n", "", "\t", "").Replace(s))
}
