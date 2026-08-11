package pkg

import (
	"strings"
	"unicode"
)

// SanitizeFilename reduces a client-supplied filename to a single path
// segment and drops every character that changes how the name is
// *interpreted* rather than how it reads: path separators, C0/C1 control
// characters and DEL, and the Unicode format characters (bidi overrides,
// zero-width marks, BOM) plus the line and paragraph separators.
//
// Two callers need this, for different reasons.
//
// The disk name needs it because a separator or a NUL would break path
// containment. SafeJoin is the hard stop there; this is the first line.
//
// The stored display name needs it because every client renders that name
// verbatim next to a download link. React escapes HTML, so a filename can
// never inject markup — but escaping does nothing to a bidi override. A
// name carrying U+202E (RIGHT-TO-LEFT OVERRIDE) between "fatura" and
// "gnp.exe" renders as "faturaexe.png" in every browser: the name a person
// reads before clicking is not the file they get. Zero-width characters do
// the same job more crudely (two uploads that look identical), and a bare
// CR or LF forges a line break in any plain-text sink the name reaches —
// the feedback app-log stores these names as message text.
//
// Non-ASCII is deliberately preserved: "belge.pdf" and "документ.pdf" are
// ordinary names and must survive intact. Only characters that render as
// nothing on their own are removed.
//
// The characters this function exists to remove are invisible, so they are
// written here as escapes on purpose — a literal in the source would be
// unreviewable, and a literal U+202E would reorder this comment itself.
//
// Returns "unnamed" when nothing usable is left.
func SanitizeFilename(name string) string {
	// Cut at the last separator of EITHER platform, before anything else.
	// filepath.Base is platform-dependent: on Linux it does not treat a
	// backslash as a separator, so a Windows client posting
	// "C:\Users\me\a.png" would land as "CUsersmea.png" in the Linux
	// container and as "a.png" on a developer's Windows machine. One input
	// must not have two answers, so the decision is made here instead.
	if i := strings.LastIndexAny(name, `/\`); i >= 0 {
		name = name[i+1:]
	}

	name = strings.Map(func(r rune) rune {
		switch {
		case unicode.IsControl(r):
			// Cc: C0 (includes NUL, CR, LF, ESC), DEL, and C1.
			return -1
		case unicode.Is(unicode.Cf, r):
			// Cf: bidi embedding/override/isolate, zero-width joiner and
			// non-joiner, word joiner, soft hyphen, BOM.
			return -1
		case r == '\u2028' || r == '\u2029':
			// Zl / Zp — not control characters by category, but they end a
			// line in enough renderers to deserve the same treatment.
			return -1
		}
		return r
	}, name)

	name = strings.TrimSpace(name)

	// "." and ".." survive the filter intact and are still traversal-shaped.
	if name == "" || name == "." || name == ".." {
		name = "unnamed"
	}

	return name
}
