package repository

// Server-to-instance migration: move all servers off one instance or relocate
// a single server, keeping server_count consistent inside a transaction.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/pkg"
)

// MigrateServers moves all servers from one instance to another within a transaction.
func (r *sqliteLiveKitRepo) MigrateServers(ctx context.Context, fromInstanceID, toInstanceID string) (int64, error) {
	sqlDB := database.RawDB(r.db)
	if sqlDB == nil {
		return 0, fmt.Errorf("MigrateServers requires *sql.DB to start transaction")
	}
	tx, err := sqlDB.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

	var count int64
	err = tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM servers WHERE livekit_instance_id = ?`, fromInstanceID,
	).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("failed to count servers to migrate: %w", err)
	}

	if count == 0 {
		return 0, nil
	}

	_, err = tx.ExecContext(ctx,
		`UPDATE servers SET livekit_instance_id = ? WHERE livekit_instance_id = ?`,
		toInstanceID, fromInstanceID,
	)
	if err != nil {
		return 0, fmt.Errorf("failed to migrate servers: %w", err)
	}

	_, err = tx.ExecContext(ctx,
		`UPDATE livekit_instances SET server_count = 0 WHERE id = ?`, fromInstanceID,
	)
	if err != nil {
		return 0, fmt.Errorf("failed to reset source server count: %w", err)
	}

	_, err = tx.ExecContext(ctx,
		`UPDATE livekit_instances SET server_count = server_count + ? WHERE id = ?`,
		count, toInstanceID,
	)
	if err != nil {
		return 0, fmt.Errorf("failed to update target server count: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("failed to commit migration transaction: %w", err)
	}

	return count, nil
}

// MigrateOneServer moves a single server to a different LiveKit instance within a transaction.
func (r *sqliteLiveKitRepo) MigrateOneServer(ctx context.Context, serverID, newInstanceID string) error {
	sqlDB := database.RawDB(r.db)
	if sqlDB == nil {
		return fmt.Errorf("MigrateOneServer requires *sql.DB to start transaction")
	}
	tx, err := sqlDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

	var oldInstanceID sql.NullString
	err = tx.QueryRowContext(ctx,
		`SELECT livekit_instance_id FROM servers WHERE id = ?`, serverID,
	).Scan(&oldInstanceID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return pkg.ErrNotFound
		}
		return fmt.Errorf("failed to get server current instance: %w", err)
	}

	_, err = tx.ExecContext(ctx,
		`UPDATE servers SET livekit_instance_id = ? WHERE id = ?`,
		newInstanceID, serverID,
	)
	if err != nil {
		return fmt.Errorf("failed to update server instance: %w", err)
	}

	// Decrement old instance count if it changed
	if oldInstanceID.Valid && oldInstanceID.String != "" && oldInstanceID.String != newInstanceID {
		_, err = tx.ExecContext(ctx,
			`UPDATE livekit_instances SET server_count = MAX(server_count - 1, 0) WHERE id = ?`,
			oldInstanceID.String,
		)
		if err != nil {
			return fmt.Errorf("failed to decrement old instance count: %w", err)
		}
	}

	_, err = tx.ExecContext(ctx,
		`UPDATE livekit_instances SET server_count = server_count + 1 WHERE id = ?`,
		newInstanceID,
	)
	if err != nil {
		return fmt.Errorf("failed to increment new instance count: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("failed to commit single server migration: %w", err)
	}

	return nil
}
