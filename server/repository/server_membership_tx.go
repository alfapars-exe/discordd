package repository

import (
	"context"
	"database/sql"

	"github.com/argeinfina/hichat/database"
)

// ServerMembershipTxRepos bundles tx-scoped repositories for the
// JoinServer write set (AddMember + default-role AssignToUser). Both
// repositories already accept database.TxQuerier, so binding them to a
// *sql.Tx requires no changes to the repositories themselves. Mirrors
// MessageTxRepos/MessageTxRunner (message_tx.go) and
// DeviceTxRepos/DeviceTxRunner (device_tx.go).
type ServerMembershipTxRepos struct {
	Server ServerRepository
	Role   RoleRepository
}

// ServerMembershipTxRunner runs fn with Server/Role repositories bound to a
// single transaction: either the whole join (membership row + default role
// assignment) commits, or none of it does.
type ServerMembershipTxRunner interface {
	InTx(ctx context.Context, fn func(r *ServerMembershipTxRepos) error) error
}

type serverMembershipTxRunner struct {
	db *sql.DB
}

func NewServerMembershipTxRunner(db *sql.DB) ServerMembershipTxRunner {
	return &serverMembershipTxRunner{db: db}
}

func (r *serverMembershipTxRunner) InTx(ctx context.Context, fn func(*ServerMembershipTxRepos) error) error {
	return database.WithTx(ctx, r.db, func(tx *sql.Tx) error {
		return fn(&ServerMembershipTxRepos{
			Server: NewSQLiteServerRepo(tx),
			Role:   NewSQLiteRoleRepo(tx),
		})
	})
}
