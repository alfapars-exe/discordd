// DeviceTxRunner atomicity tests against a real local SQLite database —
// the proof that a failure between Register and UploadPrekeys leaves no
// orphan device row behind (the service-level tests use a passthrough
// runner and only verify error propagation). Mirrors message_tx_test.go's
// TestMessageTxRunner_CommitsWholeWriteSet / _RollsBackOnError shape.
//
// The DB harness (newTestDB, countRows, execSeed) lives in testdb_test.go
// and is shared with the other repository tests.
package repository

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
)

func TestDeviceTxRunner_CommitsWholeWriteSet(t *testing.T) {
	db := newTestDB(t)
	execSeed(t, db, []seedStmt{
		{`INSERT INTO users (id, username, password_hash) VALUES (?, ?, 'x')`, []any{"dtx-user-1", "dtxuser1"}},
	})
	runner := NewDeviceTxRunner(db.Conn)
	ctx := context.Background()

	device := &models.Device{
		UserID:          "dtx-user-1",
		DeviceID:        "dev-1",
		IdentityKey:     "id-key",
		SignedPrekey:    "sp",
		SignedPrekeyID:  1,
		SignedPrekeySig: "sig",
	}
	err := runner.InTx(ctx, func(r *DeviceTxRepos) error {
		if err := r.Device.Register(ctx, device); err != nil {
			return err
		}
		return r.Device.UploadPrekeys(ctx, "dtx-user-1", "dev-1", []models.OTPKey{{PrekeyID: 1, PublicKey: "pk1"}})
	})
	if err != nil {
		t.Fatalf("InTx: %v", err)
	}

	if n := countRows(t, db, `SELECT COUNT(*) FROM user_devices WHERE user_id = ? AND device_id = ?`, "dtx-user-1", "dev-1"); n != 1 {
		t.Errorf("user_devices = %d, want 1", n)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM device_one_time_prekeys WHERE user_id = ? AND device_id = ?`, "dtx-user-1", "dev-1"); n != 1 {
		t.Errorf("device_one_time_prekeys = %d, want 1", n)
	}
}

// TestDeviceTxRunner_RollsBackOnError — the atomicity proof (P1.12): when the
// prekey upload step fails, the already-inserted device row must vanish with
// the rollback rather than surviving as a registered device with zero
// prekeys (invisible to X3DH bundle requests until a client happened to
// re-upload).
func TestDeviceTxRunner_RollsBackOnError(t *testing.T) {
	db := newTestDB(t)
	execSeed(t, db, []seedStmt{
		{`INSERT INTO users (id, username, password_hash) VALUES (?, ?, 'x')`, []any{"dtx-user-2", "dtxuser2"}},
	})
	runner := NewDeviceTxRunner(db.Conn)
	ctx := context.Background()

	device := &models.Device{
		UserID:          "dtx-user-2",
		DeviceID:        "dev-2",
		IdentityKey:     "id-key",
		SignedPrekey:    "sp",
		SignedPrekeyID:  1,
		SignedPrekeySig: "sig",
	}
	sentinel := errors.New("prekey upload exploded")
	err := runner.InTx(ctx, func(r *DeviceTxRepos) error {
		if err := r.Device.Register(ctx, device); err != nil {
			return err
		}
		return sentinel
	})
	if !errors.Is(err, sentinel) {
		t.Fatalf("InTx error = %v, want sentinel", err)
	}

	if n := countRows(t, db, `SELECT COUNT(*) FROM user_devices WHERE user_id = ? AND device_id = ?`, "dtx-user-2", "dev-2"); n != 0 {
		t.Errorf("user_devices = %d after rollback, want 0 (orphan registered device with no prekeys!)", n)
	}
}
