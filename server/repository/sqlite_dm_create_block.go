package repository

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

// UnblockedDMChannelCreator commits a new channel only while neither directed
// block exists. created=false returns an existing history row without a new
// channel event. Trusted import/admin callers retain CreateChannel semantics.
type UnblockedDMChannelCreator interface {
	CreateChannelUnblocked(context.Context, *models.DMChannel) (created bool, err error)
}

func (r *sqliteDMRepo) CreateChannelUnblocked(ctx context.Context, channel *models.DMChannel) (bool, error) {
	if channel == nil || channel.User1ID == "" || channel.User2ID == "" || channel.User1ID >= channel.User2ID {
		return false, pkg.ErrBadRequest
	}
	raw := database.RawDB(r.db)
	if raw == nil {
		return false, fmt.Errorf("%w: DM creation requires database connection", pkg.ErrInternal)
	}
	created := false
	var committed models.DMChannel
	err := database.WithTx(ctx, raw, func(tx *sql.Tx) error {
		if err := lockDMCreationPair(ctx, tx, channel.User1ID, channel.User2ID, database.IsPostgres(r.db)); err != nil {
			return err
		}
		repo := &sqliteDMRepo{db: tx}
		existing, err := repo.GetChannelByUsers(ctx, channel.User1ID, channel.User2ID)
		if err != nil {
			return err
		}
		if existing != nil {
			committed = *existing
			return nil
		}
		var blocked bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM friendships WHERE status='blocked' AND ((user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?)))`, channel.User1ID, channel.User2ID, channel.User2ID, channel.User1ID).Scan(&blocked); err != nil {
			return err
		}
		if blocked {
			return pkg.ErrForbidden
		}
		committed = *channel
		if err := repo.CreateChannel(ctx, &committed); err != nil {
			return err
		}
		created = true
		return nil
	})
	if err != nil {
		return false, err
	}
	*channel = committed
	return created, nil
}
