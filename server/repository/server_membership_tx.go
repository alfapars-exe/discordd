package repository

import (
	"context"
	"database/sql"

	"github.com/argeinfina/hichat/database"
)

// ServerMembershipTxRepos binds membership and role writes to one transaction.
// Role mutations also use User and Timeout to read the resulting member view.
type ServerMembershipTxRepos struct {
	Server  ServerRepository
	Role    RoleRepository
	User    UserRepository
	Timeout MemberTimeoutRepository
}

// ServerMembershipTxRunner runs fn with Server/Role repositories bound to a
// single transaction: either the whole join (membership row + default role
// assignment) commits, or none of it does.
type ServerMembershipTxRunner interface {
	InTx(ctx context.Context, fn func(r *ServerMembershipTxRepos) error) error
}

// ServerMembershipTransactions binds membership and role writes to the same database.
type ServerMembershipTransactions struct {
	db *sql.DB
}

// ServerRoleTxRunner takes the per-server ACL fence before reading membership
// or permissions. The same fence is used by ACL writers and notification fanout.
type ServerRoleTxRunner interface {
	WithServerRoles(ctx context.Context, serverID string, fn func(*ServerMembershipTxRepos) error) error
}

func NewServerMembershipTxRunner(db *sql.DB) *ServerMembershipTransactions {
	return &ServerMembershipTransactions{db: db}
}

func (r *ServerMembershipTransactions) WithServerRoles(ctx context.Context, serverID string, fn func(*ServerMembershipTxRepos) error) error {
	return database.WithTx(ctx, r.db, func(tx *sql.Tx) error {
		if database.IsPostgres(r.db) {
			if _, err := tx.ExecContext(ctx, "SELECT pg_advisory_xact_lock(hashtextextended(?,0))", serverID); err != nil {
				return err
			}
		}
		repos := serverMembershipRepos(tx)
		repos.User = NewSQLiteUserRepo(tx)
		repos.Timeout = NewSQLiteMemberTimeoutRepo(tx)
		return fn(repos)
	})
}

func serverMembershipRepos(tx *sql.Tx) *ServerMembershipTxRepos {
	return &ServerMembershipTxRepos{Server: NewSQLiteServerRepo(tx), Role: NewSQLiteRoleRepo(tx)}
}

func (r *ServerMembershipTransactions) InTx(ctx context.Context, fn func(*ServerMembershipTxRepos) error) error {
	return database.WithTx(ctx, r.db, func(tx *sql.Tx) error {
		return fn(serverMembershipRepos(tx))
	})
}
