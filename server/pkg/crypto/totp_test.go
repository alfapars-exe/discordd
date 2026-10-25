package crypto

import (
	"encoding/base32"
	"testing"
)

// RFC 6238 Appendix B (SHA-1), https://www.rfc-editor.org/rfc/rfc6238.
func TestTOTPRFC6238SHA1Vectors(t *testing.T) {
	secret := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString([]byte("12345678901234567890"))
	for _, tc := range []struct {
		unix int64
		want string
	}{{59, "94287082"}, {1111111109, "07081804"}, {1111111111, "14050471"}, {1234567890, "89005924"}, {2000000000, "69279037"}, {20000000000, "65353130"}} {
		got, err := TOTP(secret, tc.unix/30, 8)
		if err != nil || got != tc.want {
			t.Errorf("time %d: got=%s want=%s err=%v", tc.unix, got, tc.want, err)
		}
	}
}

func TestTOTPBoundedClockWindow(t *testing.T) {
	secret := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString([]byte("12345678901234567890"))
	for _, delta := range []int64{-2, -1, 0, 1, 2} {
		code, _ := TOTP(secret, 100+delta, 6)
		step, ok := MatchTOTP(secret, code, 3000)
		want := delta >= -1 && delta <= 1
		if ok != want || (ok && step != 100+delta) {
			t.Errorf("delta=%d step=%d ok=%v", delta, step, ok)
		}
	}
	for _, code := range []string{"", "12345", "1234567", "１２３４５６", "ABCDEF"} {
		if _, ok := MatchTOTP(secret, code, 3000); ok {
			t.Errorf("invalid code accepted")
		}
	}
}
