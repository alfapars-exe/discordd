// Body-rendering tests for the notification emails.
//
// REGRESSION GUARD (security scan 2026-07-31, finding N-26): the three
// notification templates interpolated `reason` and `serverName` into HTML with
// a bare fmt.Sprintf. Both are user-controlled -- models/server.go validates
// only that a server name is 1-100 runes, with no character restriction -- so a
// server named `<a href="https://evil.example">Verify your account</a>` put a
// working link into the mail its owner received when the server was deleted.
//
// The bodies live in package-level functions purely so this file can render
// them: resendSender holds a concrete *resend.Client, so a test that went
// through the sender would have to reach Resend.
package email

import (
	"strings"
	"testing"
)

// hostile carries one of each thing that changes meaning inside HTML: a tag,
// an attribute break, an entity, and a quote.
const hostile = `<a href="https://evil.example">click</a> & "quoted" <script>alert(1)</script>`

// mustEscape asserts that nothing in `body` can still act as markup, and that
// the escaped text is actually present -- a builder that dropped the value
// entirely would satisfy the first half alone.
func mustEscape(t *testing.T, label, body string) {
	t.Helper()

	for _, raw := range []string{
		`<a href="https://evil.example">`,
		`<script>`,
		`</script>`,
	} {
		if strings.Contains(body, raw) {
			t.Errorf("%s: body still contains live markup %q", label, raw)
		}
	}

	for _, want := range []string{
		"&lt;a href=&#34;https://evil.example&#34;&gt;",
		"&lt;script&gt;",
		"&amp;",
		"&#34;quoted&#34;",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("%s: escaped form %q missing — was the value dropped instead of escaped?", label, want)
		}
	}
}

func TestPlatformBanHTML_EscapesReason(t *testing.T) {
	mustEscape(t, "platformBanHTML", platformBanHTML(hostile))
}

func TestAccountDeleteHTML_EscapesReason(t *testing.T) {
	mustEscape(t, "accountDeleteHTML", accountDeleteHTML(hostile))
}

func TestServerDeleteHTML_EscapesBothFields(t *testing.T) {
	// Both interpolations matter: escaping only one would still pass a test
	// that fed the same string to both, so they are checked separately.
	t.Run("server name", func(t *testing.T) {
		mustEscape(t, "serverDeleteHTML(serverName)", serverDeleteHTML(hostile, "plain reason"))
	})
	t.Run("reason", func(t *testing.T) {
		mustEscape(t, "serverDeleteHTML(reason)", serverDeleteHTML("plain name", hostile))
	})
}

// The escaping must not mangle ordinary text, or every legitimate ban reason
// would render with entity noise in it.
func TestBodies_LeaveBenignTextAlone(t *testing.T) {
	const benign = "Spam in #general, third warning"

	for _, tc := range []struct {
		name string
		body string
	}{
		{"platformBanHTML", platformBanHTML(benign)},
		{"accountDeleteHTML", accountDeleteHTML(benign)},
		{"serverDeleteHTML/name", serverDeleteHTML(benign, "r")},
		{"serverDeleteHTML/reason", serverDeleteHTML("n", benign)},
	} {
		if !strings.Contains(tc.body, benign) {
			t.Errorf("%s: benign text was altered; want it verbatim", tc.name)
		}
	}
}

// The surrounding template must survive the change -- a builder that returned
// only the escaped value would pass every assertion above.
func TestBodies_KeepTheirTemplate(t *testing.T) {
	for _, tc := range []struct {
		name, body, marker string
	}{
		{"platformBanHTML", platformBanHTML("r"), "Account Suspended"},
		{"accountDeleteHTML", accountDeleteHTML("r"), "<!DOCTYPE html>"},
		{"serverDeleteHTML", serverDeleteHTML("n", "r"), "<!DOCTYPE html>"},
	} {
		if !strings.Contains(tc.body, tc.marker) {
			t.Errorf("%s: template marker %q missing", tc.name, tc.marker)
		}
	}
}
