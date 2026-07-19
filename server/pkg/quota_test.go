package pkg

import (
	"errors"
	"strings"
	"testing"
)

func TestCheckQuota_zeroCapMeansDisabled(t *testing.T) {
	// Ops flow: an internal / test deployment sets
	// HICHAT_USER_QUOTA_BYTES=0 to disable per-user caps. The predicate
	// must let every upload through in that case, regardless of size.
	err := CheckQuota(QuotaCheck{UsedBytes: 1 << 40, IncomingBytes: 1 << 40, CapBytes: 0})
	if err != nil {
		t.Errorf("cap=0 should disable enforcement, got %v", err)
	}
}

func TestCheckQuota_negativeCapAlsoDisabled(t *testing.T) {
	// Defense-in-depth against a caller doing arithmetic on the cap
	// that underflows to negative — treat "no cap" identically to
	// "cap=0" so the failure mode is safe.
	err := CheckQuota(QuotaCheck{UsedBytes: 100, IncomingBytes: 100, CapBytes: -1})
	if err != nil {
		t.Errorf("cap<0 should disable enforcement, got %v", err)
	}
}

func TestCheckQuota_negativeIncomingRefused(t *testing.T) {
	// A negative "incoming size" is only reachable via a caller bug; if
	// we happily let it through, that bug becomes a way to shrink the
	// user's tracked usage on subsequent audits. Fail closed.
	err := CheckQuota(QuotaCheck{UsedBytes: 0, IncomingBytes: -1, CapBytes: 100})
	if !errors.Is(err, ErrBadRequest) {
		t.Errorf("negative incoming should wrap ErrBadRequest, got %v", err)
	}
}

func TestCheckQuota_exactFitAccepted(t *testing.T) {
	// Boundary pin: used+incoming == cap is inclusive. Using strict > in
	// the implementation would reject this; the intent is "must not
	// EXCEED the cap".
	err := CheckQuota(QuotaCheck{UsedBytes: 999, IncomingBytes: 1, CapBytes: 1000})
	if err != nil {
		t.Errorf("exact fit should be allowed, got %v", err)
	}
}

func TestCheckQuota_oneByteOverRejected(t *testing.T) {
	err := CheckQuota(QuotaCheck{UsedBytes: 999, IncomingBytes: 2, CapBytes: 1000})
	if !errors.Is(err, ErrQuotaExceeded) {
		t.Errorf("1 byte over should trigger ErrQuotaExceeded, got %v", err)
	}
	// Error message must carry the numbers so a client toast can render
	// them without a second round-trip. Just spot-check the pieces.
	msg := err.Error()
	for _, want := range []string{"999", "1000", "user storage quota"} {
		if !strings.Contains(msg, want) {
			t.Errorf("error missing %q — cannot render to client: %s", want, msg)
		}
	}
}

func TestCheckQuota_userAlreadyOverCapCannotAddZero(t *testing.T) {
	// If a user's UsedBytes already exceeds the cap (data corruption /
	// cap shrank / retroactive policy tightening), the predicate must
	// still refuse further growth. A 0-byte "keep-alive" write is a
	// pathological but real-world case.
	err := CheckQuota(QuotaCheck{UsedBytes: 1500, IncomingBytes: 0, CapBytes: 1000})
	if !errors.Is(err, ErrQuotaExceeded) {
		t.Errorf("already-over user must not grow further, got %v", err)
	}
}

func TestQuotaCheck_RemainingClampsAtZero(t *testing.T) {
	// Used > Cap → Remaining=0, never negative. A negative subtraction
	// leaking through would break any client that renders "you have
	// {n} bytes left" as a UI number.
	q := QuotaCheck{UsedBytes: 1500, CapBytes: 1000}
	if got := q.Remaining(); got != 0 {
		t.Errorf("Remaining over cap = %d, want 0", got)
	}
	q = QuotaCheck{UsedBytes: 200, CapBytes: 1000}
	if got := q.Remaining(); got != 800 {
		t.Errorf("Remaining below cap = %d, want 800", got)
	}
}

func TestUserQuotaBytes_defaultWhenUnset(t *testing.T) {
	t.Setenv("HICHAT_USER_QUOTA_BYTES", "")
	if got := UserQuotaBytes(); got != DefaultUserQuotaBytes {
		t.Errorf("empty env should fall back to default (%d), got %d", DefaultUserQuotaBytes, got)
	}
}

func TestUserQuotaBytes_bareInteger(t *testing.T) {
	t.Setenv("HICHAT_USER_QUOTA_BYTES", "1048576")
	if got := UserQuotaBytes(); got != 1_048_576 {
		t.Errorf("bare int should be bytes, got %d", got)
	}
}

func TestUserQuotaBytes_binarySuffixes(t *testing.T) {
	cases := []struct {
		raw  string
		want int64
	}{
		{"1KiB", 1024},
		{"2MiB", 2 * 1024 * 1024},
		{"5GiB", 5 * 1024 * 1024 * 1024},
		{"1TiB", 1024 * 1024 * 1024 * 1024},
	}
	for _, c := range cases {
		t.Run(c.raw, func(t *testing.T) {
			t.Setenv("HICHAT_USER_QUOTA_BYTES", c.raw)
			if got := UserQuotaBytes(); got != c.want {
				t.Errorf("%s → %d, want %d", c.raw, got, c.want)
			}
		})
	}
}

func TestUserQuotaBytes_decimalSuffixes(t *testing.T) {
	// Decimal suffixes (KB / MB / GB / TB) are base-10 powers, not
	// base-2. This is the operator-friendly convention — a "5GB" quota
	// in a cloud console means 5,000,000,000 bytes, not 5,368,709,120.
	t.Setenv("HICHAT_USER_QUOTA_BYTES", "5GB")
	if got := UserQuotaBytes(); got != 5_000_000_000 {
		t.Errorf("5GB → %d, want 5,000,000,000 (decimal)", got)
	}
}

func TestUserQuotaBytes_caseInsensitive(t *testing.T) {
	// Operators typing "5gb" or "5Gib" should both work; rejecting case
	// variants is more surprise than security.
	for _, raw := range []string{"5gb", "5GB", "5Gb"} {
		t.Setenv("HICHAT_USER_QUOTA_BYTES", raw)
		if got := UserQuotaBytes(); got != 5_000_000_000 {
			t.Errorf("case variant %q → %d, want 5,000,000,000", raw, got)
		}
	}
}

func TestUserQuotaBytes_malformedFallsBackToDefault(t *testing.T) {
	// Garbage config must NOT throw or crash — treat it as unset. The
	// admin sees the fallback in the boot log; changing behavior on
	// startup based on a typo would be user-hostile.
	for _, raw := range []string{"abc", "5PB", "-100", "5.5GB"} {
		t.Setenv("HICHAT_USER_QUOTA_BYTES", raw)
		if got := UserQuotaBytes(); got != DefaultUserQuotaBytes {
			t.Errorf("malformed %q → %d, want default %d", raw, got, DefaultUserQuotaBytes)
		}
	}
}

func TestUserQuotaBytes_explicitZeroDisablesCap(t *testing.T) {
	// Ops flow: HICHAT_USER_QUOTA_BYTES=0 disables the cap. Combined
	// with CheckQuota's zero-cap behavior, this gives operators one
	// clean way to turn the whole feature off.
	t.Setenv("HICHAT_USER_QUOTA_BYTES", "0")
	if got := UserQuotaBytes(); got != 0 {
		t.Errorf("explicit 0 should return 0 (disable), got %d", got)
	}
}
