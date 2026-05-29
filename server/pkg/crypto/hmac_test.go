package crypto

import "testing"

func TestBackupHMAC_DetectsTampering(t *testing.T) {
	master := make([]byte, 32)
	for i := range master {
		master[i] = byte(i)
	}
	key := DeriveBackupHMACKey(master)
	if len(key) == 0 {
		t.Fatal("DeriveBackupHMACKey returned an empty key")
	}

	base := BackupHMAC(key, "user-1", 3, "aes-256-gcm", "ciphertext", "nonce123", "salt456")
	if base == "" {
		t.Fatal("BackupHMAC returned empty string")
	}
	if !VerifyBackupHMAC(key, base, "user-1", 3, "aes-256-gcm", "ciphertext", "nonce123", "salt456") {
		t.Fatal("verify failed for an untampered backup")
	}

	tampers := []struct {
		name string
		ok   bool
	}{
		{"user", VerifyBackupHMAC(key, base, "user-2", 3, "aes-256-gcm", "ciphertext", "nonce123", "salt456")},
		{"version", VerifyBackupHMAC(key, base, "user-1", 4, "aes-256-gcm", "ciphertext", "nonce123", "salt456")},
		{"algorithm", VerifyBackupHMAC(key, base, "user-1", 3, "aes-128-gcm", "ciphertext", "nonce123", "salt456")},
		{"data", VerifyBackupHMAC(key, base, "user-1", 3, "aes-256-gcm", "tampered", "nonce123", "salt456")},
		{"nonce", VerifyBackupHMAC(key, base, "user-1", 3, "aes-256-gcm", "ciphertext", "nonceXXX", "salt456")},
		{"salt", VerifyBackupHMAC(key, base, "user-1", 3, "aes-256-gcm", "ciphertext", "nonce123", "saltXXX")},
	}
	for _, tc := range tampers {
		if tc.ok {
			t.Errorf("verify accepted a tampered %q field", tc.name)
		}
	}

	otherKey := DeriveBackupHMACKey(append([]byte{0xff}, master[1:]...))
	if VerifyBackupHMAC(otherKey, base, "user-1", 3, "aes-256-gcm", "ciphertext", "nonce123", "salt456") {
		t.Error("verify accepted an HMAC computed under a different key")
	}
}

// TestBackupHMAC_Canonicalization moves a byte across the data|nonce boundary.
// Without length-prefix framing, "x"+"yz" and "xy"+"z" hash the same input.
func TestBackupHMAC_Canonicalization(t *testing.T) {
	key := DeriveBackupHMACKey(make([]byte, 32))
	a := BackupHMAC(key, "u", 1, "alg", "x", "yz", "s")
	b := BackupHMAC(key, "u", 1, "alg", "xy", "z", "s")
	if a == b {
		t.Fatal("length-prefix framing failed: distinct field splits produced the same HMAC")
	}
}
