package repository

import (
	"context"
	"database/sql"

	"github.com/argeinfina/hichat/database"
)

// DMTxRepos bundles tx-scoped repositories for the DM send write set
// (dm_messages INSERT + recipient dm_reads bump + dm_request notification).
// Same shape as MessageTxRepos; every constructor already takes a
// database.TxQuerier, so binding them to a *sql.Tx needs no repo changes.
type DMTxRepos struct {
	DM           DMRepository
	DMRead       DMReadRepository
	Notification NotificationRepository
}

// DMMessageTxRunner runs fn with repositories bound to a single transaction:
// either the whole DM send write set commits, or none of it does.
type DMMessageTxRunner interface {
	InTx(ctx context.Context, fn func(r *DMTxRepos) error) error
}

type dmMessageTxRunner struct {
	db *sql.DB
}

func NewDMMessageTxRunner(db *sql.DB) DMMessageTxRunner {
	return &dmMessageTxRunner{db: db}
}

func (r *dmMessageTxRunner) InTx(ctx context.Context, fn func(*DMTxRepos) error) error {
	return database.WithTx(ctx, r.db, func(tx *sql.Tx) error {
		return fn(&DMTxRepos{
			DM:           NewSQLiteDMRepo(tx),
			DMRead:       NewSQLiteDMReadRepo(tx),
			Notification: NewSQLiteNotificationRepo(tx),
		})
	})
}
