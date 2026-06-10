package repository

import (
	"context"
	"database/sql"

	"github.com/argeinfina/hichat/database"
)

// MessageTxRepos bundles tx-scoped repositories for the message-create write
// set (message INSERT + unread increments + mention rows). Every constructor
// already accepts database.TxQuerier, so binding them to a *sql.Tx requires
// no changes to the repositories themselves.
type MessageTxRepos struct {
	Message     MessageRepository
	Mention     MentionRepository
	RoleMention RoleMentionRepository
	ReadState   ReadStateRepository
}

// MessageTxRunner runs fn with repositories bound to a single transaction:
// either the whole message-create write set commits, or none of it does.
type MessageTxRunner interface {
	InTx(ctx context.Context, fn func(r *MessageTxRepos) error) error
}

type messageTxRunner struct {
	db *sql.DB
}

func NewMessageTxRunner(db *sql.DB) MessageTxRunner {
	return &messageTxRunner{db: db}
}

func (r *messageTxRunner) InTx(ctx context.Context, fn func(*MessageTxRepos) error) error {
	return database.WithTx(ctx, r.db, func(tx *sql.Tx) error {
		return fn(&MessageTxRepos{
			Message:     NewSQLiteMessageRepo(tx),
			Mention:     NewSQLiteMentionRepo(tx),
			RoleMention: NewSQLiteRoleMentionRepo(tx),
			ReadState:   NewSQLiteReadStateRepo(tx),
		})
	})
}
