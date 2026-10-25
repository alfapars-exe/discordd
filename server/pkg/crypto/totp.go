package crypto

import (
	"crypto/hmac"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"strings"
)

// TOTP implements RFC 6238's SHA-1 profile, 30-second period. Eight digits
// are supported for the RFC test vectors; account enrollment uses six.
func TOTP(secret string, step int64, digits int) (string, error) {
	if step < 0 || (digits != 6 && digits != 8) {
		return "", fmt.Errorf("invalid TOTP parameters")
	}
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(secret)
	if err != nil || len(key) < 20 {
		return "", fmt.Errorf("invalid TOTP secret")
	}
	var counter [8]byte
	binary.BigEndian.PutUint64(counter[:], uint64(step))
	mac := hmac.New(sha1.New, key)
	_, _ = mac.Write(counter[:])
	sum := mac.Sum(nil)
	offset := sum[len(sum)-1] & 15
	value := binary.BigEndian.Uint32(sum[offset:offset+4]) & 0x7fffffff
	mod := uint32(1000000)
	if digits == 8 {
		mod = 100000000
	}
	return fmt.Sprintf("%0*d", digits, value%mod), nil
}

func MatchTOTP(secret, code string, unix int64) (int64, bool) {
	code = strings.TrimSpace(code)
	if len(code) != 6 {
		return 0, false
	}
	for _, ch := range code {
		if ch < '0' || ch > '9' {
			return 0, false
		}
	}
	step := unix / 30
	for _, delta := range []int64{0, -1, 1} {
		candidate, err := TOTP(secret, step+delta, 6)
		if err == nil && subtle.ConstantTimeCompare([]byte(candidate), []byte(code)) == 1 {
			return step + delta, true
		}
	}
	return 0, false
}
