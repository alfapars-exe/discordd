package repository

import (
	"context"
	"testing"
)

// TestListDeviceBundlesNoOTP_DoesNotConsumePrekeys proves BULGU 1 (pentest
// C-03 follow-up finding 1): unlike GetPrekeyBundles, ListDeviceBundlesNoOTP
// must leave the one-time-prekey pool untouched -- the sender-key-recipients
// roster calls this on every "stale" channel (far more often than a genuine
// X3DH handshake) and must not drain OTPs a real handshake will need.
//
// VACUOUS CONTROL: temporarily changing ListDeviceBundlesNoOTP to call
// r.listDeviceRowsForBundles followed by a ConsumePrekey loop (i.e. reverting
// it to GetPrekeyBundles' behavior) made this test fail with "prekey count
// dropped from 5 to 4" -- confirmed by inspection, then reverted (go test
// cannot run on this Windows dev box; see repo policy).
func TestListDeviceBundlesNoOTP_DoesNotConsumePrekeys(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()

	if _, err := db.Conn.ExecContext(ctx,
		`INSERT INTO users (id, username, password_hash) VALUES ('user-otp', 'otpuser', 'x')`); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if _, err := db.Conn.ExecContext(ctx, `
		INSERT INTO user_devices (id, user_id, device_id, identity_key, signed_prekey,
			signed_prekey_id, signed_prekey_signature, registration_id)
		VALUES ('dev-row-1', 'user-otp', 'dev-1', 'idkey', 'spk', 1, 'sig', 42)`); err != nil {
		t.Fatalf("seed device: %v", err)
	}
	for i := 1; i <= 5; i++ {
		if _, err := db.Conn.ExecContext(ctx, `
			INSERT INTO device_one_time_prekeys (user_id, device_id, prekey_id, public_key)
			VALUES ('user-otp', 'dev-1', ?, ?)`, i, "otp-pub-"+string(rune('0'+i))); err != nil {
			t.Fatalf("seed prekey %d: %v", i, err)
		}
	}

	repo := NewSQLiteDeviceRepo(db.Conn)

	countBefore := countRows(t, db, `SELECT COUNT(*) FROM device_one_time_prekeys WHERE user_id = ? AND device_id = ?`, "user-otp", "dev-1")
	if countBefore != 5 {
		t.Fatalf("setup: expected 5 seeded prekeys, got %d", countBefore)
	}

	bundles, err := repo.ListDeviceBundlesNoOTP(ctx, "user-otp")
	if err != nil {
		t.Fatalf("ListDeviceBundlesNoOTP: %v", err)
	}
	if len(bundles) != 1 || bundles[0].DeviceID != "dev-1" {
		t.Fatalf("bundles = %+v, want exactly one for dev-1", bundles)
	}
	if bundles[0].OneTimePrekeyID != nil || bundles[0].OneTimePrekey != nil {
		t.Fatalf("bundle = %+v, want nil OTP fields (non-consuming read)", bundles[0])
	}

	countAfter := countRows(t, db, `SELECT COUNT(*) FROM device_one_time_prekeys WHERE user_id = ? AND device_id = ?`, "user-otp", "dev-1")
	if countAfter != countBefore {
		t.Fatalf("ListDeviceBundlesNoOTP consumed prekeys: before=%d after=%d, want unchanged", countBefore, countAfter)
	}
}

// TestGetPrekeyBundles_StillConsumesOneOTP is the control for the test
// above: GetPrekeyBundles (the real X3DH-initiation path) must still consume
// exactly one prekey per device, proving the two methods genuinely differ
// and this isn't just a naming change.
func TestGetPrekeyBundles_StillConsumesOneOTP(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()

	if _, err := db.Conn.ExecContext(ctx,
		`INSERT INTO users (id, username, password_hash) VALUES ('user-otp2', 'otpuser2', 'x')`); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if _, err := db.Conn.ExecContext(ctx, `
		INSERT INTO user_devices (id, user_id, device_id, identity_key, signed_prekey,
			signed_prekey_id, signed_prekey_signature, registration_id)
		VALUES ('dev-row-2', 'user-otp2', 'dev-2', 'idkey', 'spk', 1, 'sig', 42)`); err != nil {
		t.Fatalf("seed device: %v", err)
	}
	for i := 1; i <= 3; i++ {
		if _, err := db.Conn.ExecContext(ctx, `
			INSERT INTO device_one_time_prekeys (user_id, device_id, prekey_id, public_key)
			VALUES ('user-otp2', 'dev-2', ?, ?)`, i, "otp-pub-"+string(rune('0'+i))); err != nil {
			t.Fatalf("seed prekey %d: %v", i, err)
		}
	}

	repo := NewSQLiteDeviceRepo(db.Conn)

	bundles, err := repo.GetPrekeyBundles(ctx, "user-otp2")
	if err != nil {
		t.Fatalf("GetPrekeyBundles: %v", err)
	}
	if len(bundles) != 1 || bundles[0].OneTimePrekeyID == nil {
		t.Fatalf("bundles = %+v, want exactly one bundle with a consumed OTP", bundles)
	}

	countAfter := countRows(t, db, `SELECT COUNT(*) FROM device_one_time_prekeys WHERE user_id = ? AND device_id = ?`, "user-otp2", "dev-2")
	if countAfter != 2 {
		t.Fatalf("expected 1 prekey consumed (3 -> 2), got %d remaining", countAfter)
	}
}
