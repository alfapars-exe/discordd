package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/argeinfina/hichat/database"
)

// ServerMembershipTxRepos binds membership and role writes to one transaction.
// Role mutations also use User and Timeout to read the resulting member view.
type ServerMembershipTxRepos struct {
	// Nil explicitly selects legacy standalone behavior; production binds both.
	GameActivityCounter GameActivityMembershipCounter
	GameActivityWriter  GameActivityMembershipWriter
	Server              ServerRepository
	Role                RoleRepository
	User                UserRepository
	Timeout             MemberTimeoutRepository
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
// or permissions. Its callback may be retried after a row-first writer. Keep
// all external effects after the successful transaction returns.
type ServerRoleTxRunner interface {
	WithServerRoles(ctx context.Context, serverID string, fn func(*ServerMembershipTxRepos) error) error
}

func NewServerMembershipTxRunner(db *sql.DB) *ServerMembershipTransactions {
	return &ServerMembershipTransactions{db: db}
}

func (r *ServerMembershipTransactions) WithServerRoles(ctx context.Context, serverID string, fn func(*ServerMembershipTxRepos) error) error {
	postgres := database.IsPostgres(r.db)
	var options *sql.TxOptions
	if postgres {
		// The advisory SELECT may start before a revocation commits. The checks
		// following the wait must start with their own fresh snapshot.
		options = &sql.TxOptions{Isolation: sql.LevelReadCommitted}
	}
	for {
		err := database.WithTxOptions(ctx, r.db, options, func(tx *sql.Tx) error {
			if postgres {
				if _, err := tx.ExecContext(ctx, "SELECT pg_advisory_xact_lock(hashtextextended(?,0))", serverID); err != nil {
					return err
				}
			}
			return fn(serverMembershipRepos(tx, &sqliteRoleRepo{db: tx, avoidRowWait: postgres}))
		})
		var busy *roleRowBusy
		if !errors.As(err, &busy) {
			return err
		}
		// The conflicting writer may already own this row and be waiting in
		// its BEFORE trigger for our advisory lock. The transaction has now
		// rolled back. Wait for just that row in autocommit, then reauthorize.
		if _, err := r.db.ExecContext(ctx, busy.query, busy.args...); err != nil {
			return fmt.Errorf("wait for concurrent role write: %w", err)
		}
	}
}

func serverMembershipRepos(tx *sql.Tx, roles RoleRepository) *ServerMembershipTxRepos {
	server := NewSQLiteServerRepo(tx)
	return &ServerMembershipTxRepos{
		Server: server, Role: roles,
		GameActivityCounter: server, GameActivityWriter: server,
		User: NewSQLiteUserRepo(tx), Timeout: NewSQLiteMemberTimeoutRepo(tx),
	}
}

func (r *ServerMembershipTransactions) InTx(ctx context.Context, fn func(*ServerMembershipTxRepos) error) error {
	return database.WithTx(ctx, r.db, func(tx *sql.Tx) error {
		return fn(serverMembershipRepos(tx, NewSQLiteRoleRepo(tx)))
	})
}
