package crypto

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"io"

	"golang.org/x/crypto/hkdf"
)

// backupHMACInfo domain-separates the derived backup-integrity key from any
// other use of the server master key. Bump the suffix if the scheme changes.
const backupHMACInfo = "hichat-e2ee-backup-hmac-v1"

// DeriveBackupHMACKey derives a dedicated 32-byte HMAC key from the server's
// master encryption key via HKDF-SHA256. Using a derived subkey (rather than
// the raw AES-256-GCM master key) keeps the backup-integrity MAC cryptographically
// independent of credential encryption — distinct algorithms get distinct keys.
func DeriveBackupHMACKey(masterKey []byte) []byte {
	r := hkdf.New(sha256.New, masterKey, nil, []byte(backupHMACInfo))
	key := make([]byte, 32)
	if _, err := io.ReadFull(r, key); err != nil {
		// HKDF-Expand for a 32-byte output never fails in practice; treat a
		// failure as misuse and let callers detect the empty key.
		return nil
	}
	return key
}

// BackupHMAC computes HMAC-SHA256 over a length-prefixed encoding of the
// integrity-relevant key-backup fields, returned base64-encoded.
//
// Each variable-length field is prefixed with its 8-byte big-endian length so
// that moving bytes across a field boundary (e.g. "x"+"yz" vs "xy"+"z") can
// never produce the same MAC input — a canonicalization attack that naive
// concatenation (user_id‖version‖payload) would allow.
func BackupHMAC(hmacKey []byte, userID string, version int, algorithm, encryptedData, nonce, salt string) string {
	mac := hmac.New(sha256.New, hmacKey)
	writeField(mac, []byte(userID))
	var vbuf [8]byte
	binary.BigEndian.PutUint64(vbuf[:], uint64(version))
	mac.Write(vbuf[:]) // fixed width — no length prefix needed
	writeField(mac, []byte(algorithm))
	writeField(mac, []byte(encryptedData))
	writeField(mac, []byte(nonce))
	writeField(mac, []byte(salt))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// VerifyBackupHMAC recomputes the MAC and compares it to expected in constant
// time. A malformed (non-base64) expected value verifies as false.
func VerifyBackupHMAC(hmacKey []byte, expected, userID string, version int, algorithm, encryptedData, nonce, salt string) bool {
	want := BackupHMAC(hmacKey, userID, version, algorithm, encryptedData, nonce, salt)
	a, err1 := base64.StdEncoding.DecodeString(expected)
	b, err2 := base64.StdEncoding.DecodeString(want)
	if err1 != nil || err2 != nil {
		return false
	}
	return hmac.Equal(a, b)
}

func writeField(w io.Writer, b []byte) {
	var lbuf [8]byte
	binary.BigEndian.PutUint64(lbuf[:], uint64(len(b)))
	_, _ = w.Write(lbuf[:])
	_, _ = w.Write(b)
}
