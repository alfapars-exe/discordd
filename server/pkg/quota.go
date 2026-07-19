// Package pkg — per-user storage quota policy.
//
// Kept as pure functions here so the upload handlers (which own the
// "look up user's current usage" DB call and the "reject with 413" HTTP
// response) can compose the parts freely: the policy question — "if
// this user uploads N more bytes on top of their existing M bytes,
// have they exceeded the cap?" — has no reason to know about *sql.DB
// or http.ResponseWriter.
//
// The env-var lookup for the cap lives here too so operators tune it in
// exactly one place (HICHAT_USER_QUOTA_BYTES). Default is generous
// (5 GiB) — the point isn't to be stingy, it's to bound worst-case
// storage growth from a single misbehaving account.

package pkg

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// DefaultUserQuotaBytes is applied when HICHAT_USER_QUOTA_BYTES is unset
// or unparseable. 5 GiB per user comfortably fits a heavy chat user
// (photos, screen recordings, exports) while capping worst-case growth
// from a compromised or automated account at a knowable number.
const DefaultUserQuotaBytes int64 = 5 * 1024 * 1024 * 1024

// ErrQuotaExceeded is returned from CheckQuota when the incoming upload
// would push a user past their storage cap. Callers wrap it with
// ErrBadRequest OR map it directly to HTTP 413 (Payload Too Large) —
// both are correct signals for the client to surface a "you're out of
// space" toast instead of a generic failure.
var ErrQuotaExceeded = errors.New("user storage quota exceeded")

// QuotaCheck records the numbers involved in a policy decision so the
// caller can surface them in the 413 response body without recomputing.
// Bytes are int64 because a signed type catches the sql SUM(...) → NULL
// case at compile time (NULL comes back as 0 in the driver but the type
// still communicates "this can be zero or positive, never negative").
type QuotaCheck struct {
	// UsedBytes is the total already stored by this user.
	UsedBytes int64
	// IncomingBytes is the size of the file being uploaded.
	IncomingBytes int64
	// CapBytes is the effective cap that was applied.
	CapBytes int64
}

// Remaining returns how many bytes the user has left BEFORE this
// upload. Never negative — a caller that observes 0 knows "they were
// already at or over the cap" (data corruption / a cap that shrank).
func (q QuotaCheck) Remaining() int64 {
	if q.UsedBytes >= q.CapBytes {
		return 0
	}
	return q.CapBytes - q.UsedBytes
}

// CheckQuota returns ErrQuotaExceeded when accepting IncomingBytes on
// top of UsedBytes would cross CapBytes. Zero-length uploads are
// allowed even at exactly-at-cap (they don't push the user over).
// A non-positive CapBytes is treated as "no cap" — used by internal
// callers and tests that want to disable the policy.
func CheckQuota(q QuotaCheck) error {
	if q.CapBytes <= 0 {
		return nil
	}
	if q.IncomingBytes < 0 {
		// A negative incoming size is nonsense — refuse rather than
		// pretending it fits (would be exploitable if the caller
		// forwards the value into a size-tracking store).
		return fmt.Errorf("%w: negative incoming size", ErrBadRequest)
	}
	if q.UsedBytes+q.IncomingBytes > q.CapBytes {
		return fmt.Errorf("%w: %d used + %d incoming > %d cap",
			ErrQuotaExceeded, q.UsedBytes, q.IncomingBytes, q.CapBytes)
	}
	return nil
}

// UserQuotaBytes reads HICHAT_USER_QUOTA_BYTES and returns it as int64,
// falling back to DefaultUserQuotaBytes when unset / empty / malformed.
// A value of "0" is honored as "disable quota" (returns 0) — useful for
// operators running an internal / test deployment who don't want any
// per-user cap.
//
// Accepts bare integers (bytes) plus common suffixes: KB / MB / GB / TB
// (base-10) and KiB / MiB / GiB / TiB (base-2). The suffix parse is
// case-insensitive because operators writing "5gb" vs "5GB" shouldn't
// have their config silently rejected.
func UserQuotaBytes() int64 {
	raw := strings.TrimSpace(os.Getenv("HICHAT_USER_QUOTA_BYTES"))
	if raw == "" {
		return DefaultUserQuotaBytes
	}

	if n, ok := parseSize(raw); ok {
		return n
	}
	return DefaultUserQuotaBytes
}

// parseSize is a small utility for HICHAT_USER_QUOTA_BYTES only. Kept
// unexported and file-local so the operator-facing surface is exactly
// one env var; internal callers hard-code numbers.
func parseSize(raw string) (int64, bool) {
	upper := strings.ToUpper(raw)
	multiplier := int64(1)
	trim := ""

	switch {
	case strings.HasSuffix(upper, "TIB"):
		multiplier, trim = 1024*1024*1024*1024, "TIB"
	case strings.HasSuffix(upper, "GIB"):
		multiplier, trim = 1024*1024*1024, "GIB"
	case strings.HasSuffix(upper, "MIB"):
		multiplier, trim = 1024*1024, "MIB"
	case strings.HasSuffix(upper, "KIB"):
		multiplier, trim = 1024, "KIB"
	case strings.HasSuffix(upper, "TB"):
		multiplier, trim = 1_000_000_000_000, "TB"
	case strings.HasSuffix(upper, "GB"):
		multiplier, trim = 1_000_000_000, "GB"
	case strings.HasSuffix(upper, "MB"):
		multiplier, trim = 1_000_000, "MB"
	case strings.HasSuffix(upper, "KB"):
		multiplier, trim = 1_000, "KB"
	case strings.HasSuffix(upper, "B"):
		multiplier, trim = 1, "B"
	}

	numPart := strings.TrimSpace(upper)
	if trim != "" {
		numPart = strings.TrimSpace(numPart[:len(numPart)-len(trim)])
	}

	n, err := strconv.ParseInt(numPart, 10, 64)
	if err != nil {
		return 0, false
	}
	if n < 0 {
		return 0, false
	}
	// Guard against multiplication overflow — the largest legit value
	// we'd take is well under 1 PiB, so if the raw number exceeds
	// (MaxInt64 / multiplier) we treat the config as malformed.
	if multiplier > 1 && n > (int64(1<<62))/multiplier {
		return 0, false
	}
	return n * multiplier, true
}
