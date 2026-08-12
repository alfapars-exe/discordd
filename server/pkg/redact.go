package pkg

import "strings"

// ErrText renders err for logging: never nil-panics, and strips credentials
// that database driver errors routinely echo back.
//
// Why this exists: a libSQL/Turso connection failure produces an error whose
// text contains the whole DSN, including `authToken=<jwt>` — a read-write
// database credential. That error is wrapped up through the repository and
// service layers and then lands in two durable sinks: Sentry (a third party)
// and the `app_logs` table rendered by the platform-admin log viewer.
// database.RedactDSN only covers explicit DSN logging; driver error text
// never passes through it.
//
// The redaction is duplicated here rather than importing database/ because
// pkg is the bottom layer — depending on database/ would invert that.
//
// Prefer this over slog.Any("err", err) at any site whose record can reach
// Sentry: pkg/logx/sentry.go copies attrs via a.Value.Any() into
// sentry.Context, which JSON-marshals error values to `{}` (their fields are
// unexported), silently discarding the message.
func ErrText(err error) string {
	if err == nil {
		return ""
	}
	return RedactSecrets(err.Error())
}

// secretParams are query-string keys whose values must never be logged.
// Matched case-insensitively — drivers and upstream services are not
// consistent about casing (authToken / authtoken / AuthToken). "ticket=" is
// the WebSocket connection's one-time credential (client passes it as
// `?ticket=<value>`); short-lived and single-use, but still a credential.
var secretParams = []string{"authtoken=", "password=", "apikey=", "api_key=", "secret=", "token=", "ticket="}

// valueTerminators end a query-parameter value. \r matters: a CRLF-terminated
// value would otherwise swallow the \r along with the rest of the line.
const valueTerminators = "&\"' \t\r\n"

// RedactSecrets masks known credential-shaped query parameters in an
// arbitrary string. Exported so callers outside this package (e.g. the
// client-log handler, which persists client-supplied free text into
// app_logs) can apply the same masking before the text reaches a durable
// sink, not just error strings routed through ErrText.
func RedactSecrets(s string) string {
	for _, key := range secretParams {
		if key == "" {
			// indexFold("", ...) returns 0 for an empty substr, so an empty
			// key would make redactParam treat every position as a match and
			// mask the rest of the string forever. Not reachable with the
			// list above, but cheap to guard against a future entry.
			continue
		}
		s = redactParam(s, key)
	}
	return s
}

// redactParam replaces every `key<value>` occurrence with `key***`, ending the
// value at the first character that cannot be part of a query-parameter value.
// key must be lowercase; matching is case-insensitive but the original casing
// is preserved in the output so the log still reads naturally.
func redactParam(s, key string) string {
	var b strings.Builder
	rest := s

	for {
		i := indexFold(rest, key)
		if i < 0 {
			b.WriteString(rest)
			return b.String()
		}

		b.WriteString(rest[:i])
		b.WriteString(rest[i : i+len(key)]) // original casing
		b.WriteString("***")

		value := rest[i+len(key):]
		end := strings.IndexAny(value, valueTerminators)
		if end < 0 {
			return b.String()
		}
		rest = value[end:]
	}
}

// indexFold is strings.Index with ASCII case-insensitive matching. substr must
// already be lowercase.
func indexFold(s, substr string) int {
	if substr == "" {
		return 0
	}
	for i := 0; i+len(substr) <= len(s); i++ {
		if strings.EqualFold(s[i:i+len(substr)], substr) {
			return i
		}
	}
	return -1
}
