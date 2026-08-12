package repository

import (
	"context"
	"database/sql"

	"github.com/argeinfina/hichat/database"
)

// DeviceTxRepos bundles tx-scoped repositories for the device-register
// write set (device UPSERT + initial one-time-prekey upload). Register
// already accepts database.TxQuerier, so binding it to a *sql.Tx requires
// no changes to the repository itself. Mirrors MessageTxRepos/
// MessageTxRunner (message_tx.go).
type DeviceTxRepos struct {
	Device DeviceRepository
}

// DeviceTxRunner runs fn with a device repository bound to a single
// transaction: either the whole register-device write set commits, or
// none of it does.
type DeviceTxRunner interface {
	InTx(ctx context.Context, fn func(r *DeviceTxRepos) error) error
}

type deviceTxRunner struct {
	db *sql.DB
}

func NewDeviceTxRunner(db *sql.DB) DeviceTxRunner {
	return &deviceTxRunner{db: db}
}

func (r *deviceTxRunner) InTx(ctx context.Context, fn func(*DeviceTxRepos) error) error {
	return database.WithTx(ctx, r.db, func(tx *sql.Tx) error {
		return fn(&DeviceTxRepos{
			Device: NewSQLiteDeviceRepo(tx),
		})
	})
}
