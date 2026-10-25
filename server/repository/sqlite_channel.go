package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

type sqliteChannelRepo struct {
	db database.TxQuerier
}

func NewSQLiteChannelRepo(db database.TxQuerier) ChannelRepository {
	return &sqliteChannelRepo{db: db}
}

// scanChannel scans one channels row in the column order shared by the channel
// list queries (GetAllByServer, GetByCategoryID).
func scanChannel(rows *sql.Rows) (models.Channel, error) {
	var ch models.Channel
	err := rows.Scan(
		&ch.ID, &ch.ServerID, &ch.Name, &ch.Type, &ch.CategoryID, &ch.Topic,
		&ch.Position, &ch.UserLimit, &ch.Bitrate, &ch.CreatedAt,
		&ch.ParentChannelID, &ch.StarterMessageID, &ch.ArchivedAt, &ch.ReplyCount,
	)
	return ch, err
}

func (r *sqliteChannelRepo) Create(ctx context.Context, channel *models.Channel) error {
	id, err := generateID()
	if err != nil {
		return fmt.Errorf("failed to create channel: %w", err)
	}
	channel.ID = id

	query := `
		INSERT INTO channels (id, server_id, name, type, category_id, topic, position, user_limit, bitrate, parent_channel_id, starter_message_id, archived_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

	if _, err := r.db.ExecContext(ctx, query,
		channel.ID,
		channel.ServerID,
		channel.Name,
		channel.Type,
		channel.CategoryID,
		channel.Topic,
		channel.Position,
		channel.UserLimit,
		channel.Bitrate,
		channel.ParentChannelID,
		channel.StarterMessageID,
		channel.ArchivedAt,
	); err != nil {
		return fmt.Errorf("failed to create channel: %w", err)
	}

	// Best-effort read-back of the DB-side default created_at (RETURNING avoided
	// for Turso/Hrana safety — see sqlite_user.go Create).
	_ = r.db.QueryRowContext(ctx, "SELECT created_at FROM channels WHERE id = ?", channel.ID).Scan(&channel.CreatedAt)

	return nil
}

func (r *sqliteChannelRepo) GetByID(ctx context.Context, id string) (*models.Channel, error) {
	query := `
		SELECT id, server_id, name, type, category_id, topic, position, user_limit, bitrate, created_at, parent_channel_id, starter_message_id, archived_at, 0
		FROM channels WHERE id = ?`

	ch := &models.Channel{}
	err := r.db.QueryRowContext(ctx, query, id).Scan(
		&ch.ID, &ch.ServerID, &ch.Name, &ch.Type, &ch.CategoryID, &ch.Topic,
		&ch.Position, &ch.UserLimit, &ch.Bitrate, &ch.CreatedAt, &ch.ParentChannelID, &ch.StarterMessageID, &ch.ArchivedAt, &ch.ReplyCount,
	)

	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get channel by id: %w", err)
	}

	return ch, nil
}

func (r *sqliteChannelRepo) GetAllByServer(ctx context.Context, serverID string) ([]models.Channel, error) {
	query := `
		SELECT id, server_id, name, type, category_id, topic, position, user_limit, bitrate, created_at, parent_channel_id, starter_message_id, archived_at, 0
		FROM channels WHERE server_id = ? AND type <> 'thread' ORDER BY position ASC`

	rows, err := r.db.QueryContext(ctx, query, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to get channels by server: %w", err)
	}
	return scanRows(rows, "channel", scanChannel)
}

func (r *sqliteChannelRepo) GetByCategoryID(ctx context.Context, categoryID string) ([]models.Channel, error) {
	query := `
		SELECT id, server_id, name, type, category_id, topic, position, user_limit, bitrate, created_at, parent_channel_id, starter_message_id, archived_at, 0
		FROM channels WHERE category_id = ? ORDER BY position ASC`

	rows, err := r.db.QueryContext(ctx, query, categoryID)
	if err != nil {
		return nil, fmt.Errorf("failed to get channels by category: %w", err)
	}
	return scanRows(rows, "channel", scanChannel)
}

func (r *sqliteChannelRepo) GetThreadsByParent(ctx context.Context, parentChannelID string, includeArchived bool) ([]models.Channel, error) {
	query := `SELECT id, server_id, name, type, category_id, topic, position, user_limit, bitrate, created_at, parent_channel_id, starter_message_id, archived_at,
		(SELECT COUNT(*) FROM messages WHERE messages.channel_id = channels.id)
		FROM channels WHERE parent_channel_id = ? AND type = 'thread'`
	if !includeArchived {
		query += ` AND archived_at IS NULL`
	}
	query += ` ORDER BY created_at DESC, id DESC`
	rows, err := r.db.QueryContext(ctx, query, parentChannelID)
	if err != nil {
		return nil, fmt.Errorf("failed to list threads: %w", err)
	}
	return scanRows(rows, "thread", scanChannel)
}

func (r *sqliteChannelRepo) SetThreadArchived(ctx context.Context, threadID string, archived bool) error {
	var value any
	if archived {
		value = time.Now().UTC()
	}
	result, err := r.db.ExecContext(ctx, `UPDATE channels SET archived_at=? WHERE id=? AND type='thread'`, value, threadID)
	if err != nil {
		return fmt.Errorf("failed to update thread lifecycle: %w", err)
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return pkg.ErrNotFound
	}
	return nil
}

func (r *sqliteChannelRepo) Update(ctx context.Context, channel *models.Channel) error {
	query := `
		UPDATE channels SET name = ?, topic = ?, category_id = ?
		WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query, channel.Name, channel.Topic, channel.CategoryID, channel.ID)
	if err != nil {
		return fmt.Errorf("failed to update channel: %w", err)
	}

	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to check rows affected: %w", err)
	}
	if affected == 0 {
		return pkg.ErrNotFound
	}

	return nil
}

func (r *sqliteChannelRepo) Delete(ctx context.Context, id string) error {
	// saved_messages (migration 083) bookmarks of this channel's messages:
	// the local SQLite branch cascades channels -> messages, which would take
	// the subquery's lookup path away, so this must run BEFORE the channels
	// delete; on Turso no cascade fires at all and this is the only cleanup.
	if _, err := r.db.ExecContext(ctx, `DELETE FROM saved_messages WHERE message_id IN (
		SELECT id FROM messages WHERE channel_id = ?)`, id); err != nil {
		return fmt.Errorf("failed to delete saved references for channel: %w", err)
	}
	// channel_entrance_disabled (migration 088): the FK cascade only fires
	// on local SQLite, never on Turso, so the per-channel entrance-sound
	// switch is removed explicitly — before the channels row, so a failure
	// here leaves the channel in place instead of 500-ing after it is gone.
	if _, err := r.db.ExecContext(ctx, `DELETE FROM channel_entrance_disabled WHERE channel_id = ?`, id); err != nil {
		return fmt.Errorf("failed to delete entrance settings for channel: %w", err)
	}
	result, err := r.db.ExecContext(ctx, `DELETE FROM channels WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("failed to delete channel: %w", err)
	}

	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to check rows affected: %w", err)
	}
	if affected == 0 {
		return pkg.ErrNotFound
	}

	return nil
}

// GetFileURLsByChannelID returns every attachment file_url for messages in
// the given channel. See the interface doc comment for why callers need
// this before deleting the channel.
func (r *sqliteChannelRepo) GetFileURLsByChannelID(ctx context.Context, channelID string) ([]string, error) {
	query := `SELECT file_url FROM attachments WHERE message_id IN (
		SELECT id FROM messages WHERE channel_id = ?)`

	rows, err := r.db.QueryContext(ctx, query, channelID)
	if err != nil {
		return nil, fmt.Errorf("failed to get file urls by channel id: %w", err)
	}
	defer rows.Close()

	var urls []string
	for rows.Next() {
		var url string
		if err := rows.Scan(&url); err != nil {
			return nil, fmt.Errorf("failed to scan file url: %w", err)
		}
		urls = append(urls, url)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to iterate file url rows: %w", err)
	}

	return urls, nil
}

// UpdatePositions atomically updates positions for multiple channels.
// If CategoryID is set, the channel's category is also updated (cross-category drag-and-drop).
func (r *sqliteChannelRepo) UpdatePositions(ctx context.Context, items []models.PositionUpdate) error {
	sqlDB := database.RawDB(r.db)
	if sqlDB == nil {
		return fmt.Errorf("UpdatePositions requires *sql.DB to start transaction")
	}
	tx, err := sqlDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }() // no-op once Commit succeeds (ErrTxDone), expected on the happy path

	stmtPos, err := tx.PrepareContext(ctx, `UPDATE channels SET position = ? WHERE id = ?`)
	if err != nil {
		return fmt.Errorf("failed to prepare position statement: %w", err)
	}
	defer func() { _ = stmtPos.Close() }() // transaction-scoped; commit/rollback above already decided the outcome

	stmtPosCat, err := tx.PrepareContext(ctx, `UPDATE channels SET position = ?, category_id = ? WHERE id = ?`)
	if err != nil {
		return fmt.Errorf("failed to prepare position+category statement: %w", err)
	}
	defer func() { _ = stmtPosCat.Close() }() // transaction-scoped; commit/rollback above already decided the outcome

	for _, item := range items {
		var result sql.Result
		if item.CategoryID != nil {
			// Empty string -> NULL (uncategorized)
			var catVal interface{}
			if *item.CategoryID == "" {
				catVal = nil
			} else {
				catVal = *item.CategoryID
			}
			result, err = stmtPosCat.ExecContext(ctx, item.Position, catVal, item.ID)
		} else {
			result, err = stmtPos.ExecContext(ctx, item.Position, item.ID)
		}
		if err != nil {
			return fmt.Errorf("failed to update position for channel %s: %w", item.ID, err)
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return fmt.Errorf("failed to check rows affected for channel %s: %w", item.ID, err)
		}
		if affected == 0 {
			return fmt.Errorf("%w: channel %s", pkg.ErrNotFound, item.ID)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("failed to commit transaction: %w", err)
	}

	return nil
}

func (r *sqliteChannelRepo) GetMaxPosition(ctx context.Context, categoryID string) (int, error) {
	query := `SELECT COALESCE(MAX(position), -1) FROM channels WHERE category_id = ?`

	var maxPos int
	err := r.db.QueryRowContext(ctx, query, categoryID).Scan(&maxPos)
	if err != nil {
		return 0, fmt.Errorf("failed to get max channel position: %w", err)
	}

	return maxPos, nil
}
