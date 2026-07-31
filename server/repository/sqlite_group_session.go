package repository

import (
	"context"
	"fmt"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

type sqliteGroupSessionRepo struct {
	db database.TxQuerier
}

func NewSQLiteGroupSessionRepo(db database.TxQuerier) GroupSessionRepository {
	return &sqliteGroupSessionRepo{db: db}
}

// Upsert writes every envelope of req in one transaction: a distribution
// lands atomically, so a reader never sees a partial set of recipient
// envelopes for a session_id.
func (r *sqliteGroupSessionRepo) Upsert(ctx context.Context, channelID, senderUserID, senderDeviceID string, req *models.CreateSenderKeyDistributionRequest) error {
	sqlDB := database.RawDB(r.db)
	if sqlDB == nil {
		return fmt.Errorf("Upsert requires *sql.DB to start transaction")
	}
	tx, err := sqlDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

	stmt, err := tx.PrepareContext(ctx, `
		INSERT INTO channel_sender_key_envelopes
			(channel_id, sender_user_id, sender_device_id, recipient_user_id,
			 recipient_device_id, session_id, envelope_version, message_type, ciphertext)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(channel_id, sender_user_id, sender_device_id, recipient_user_id, recipient_device_id, session_id)
		DO UPDATE SET
			envelope_version = excluded.envelope_version,
			message_type = excluded.message_type,
			ciphertext = excluded.ciphertext,
			created_at = CURRENT_TIMESTAMP`)
	if err != nil {
		return fmt.Errorf("failed to prepare envelope upsert: %w", err)
	}
	// Explicitly discarded: the statement is scoped to the caller's
	// transaction, so a close error here cannot lose data — the commit is what
	// decides. Matches the `defer func() { _ = x.Close() }()` form used
	// elsewhere in this package and keeps errcheck quiet.
	defer func() { _ = stmt.Close() }()

	for _, env := range req.Envelopes {
		if _, err := stmt.ExecContext(ctx,
			channelID, senderUserID, senderDeviceID, env.RecipientUserID,
			env.RecipientDeviceID, req.SessionID, req.Version, env.MessageType, env.Ciphertext,
		); err != nil {
			return fmt.Errorf("failed to upsert envelope for recipient %s/%s: %w", env.RecipientUserID, env.RecipientDeviceID, err)
		}
	}

	// BULGU 8 (pentest C-03 follow-up): the ON CONFLICT target above includes
	// session_id, so a key rotation INSERTs a new row per recipient instead
	// of overwriting the old one -- GetForRecipient then returns every
	// session_id this sender/device ever sealed for that recipient, growing
	// without bound over a channel's lifetime even though a reader only ever
	// wants its latest. Prune down to the 3 most recent rows per
	// (recipient_user_id, recipient_device_id) for this (channel, sender
	// device); the extra headroom over "keep 1" covers a recipient that
	// hasn't processed the previous distribution yet.
	//
	// Tiebreak on the table's own rowid, not id: created_at has only
	// second-granularity (SQLite CURRENT_TIMESTAMP), so two rotations inside
	// the same second would otherwise tie there, and id is random hex
	// (lower(hex(randomblob(8)))) with no relation to insertion order --
	// either alone could prune a row newer than one it kept. id is a TEXT
	// PRIMARY KEY (not INTEGER PRIMARY KEY), so it does NOT alias rowid; the
	// implicit rowid this table still has increases monotonically with
	// insertion order, which is what "most recent" actually means here.
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM channel_sender_key_envelopes
		WHERE channel_id = ? AND sender_user_id = ? AND sender_device_id = ?
		  AND rowid NOT IN (
			SELECT rowid FROM (
				SELECT rowid,
					ROW_NUMBER() OVER (
						PARTITION BY recipient_user_id, recipient_device_id
						ORDER BY created_at DESC, rowid DESC
					) AS rn
				FROM channel_sender_key_envelopes
				WHERE channel_id = ? AND sender_user_id = ? AND sender_device_id = ?
			) ranked
			WHERE ranked.rn <= 3
		  )`,
		channelID, senderUserID, senderDeviceID,
		channelID, senderUserID, senderDeviceID,
	); err != nil {
		return fmt.Errorf("failed to prune old envelope generations: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("failed to commit envelope upsert: %w", err)
	}
	return nil
}

// GetForRecipient returns only envelopes sealed for exactly this recipient
// device — the read-path half of C-03's fix. Filtering happens in SQL, not
// in application code, so there is no path that fetches another recipient's
// ciphertext and merely declines to return it.
func (r *sqliteGroupSessionRepo) GetForRecipient(ctx context.Context, channelID, recipientUserID, recipientDeviceID string) ([]models.SenderKeyEnvelopeResponse, error) {
	query := `
		SELECT sender_user_id, sender_device_id, session_id, envelope_version,
			message_type, ciphertext, created_at
		FROM channel_sender_key_envelopes
		WHERE channel_id = ? AND recipient_user_id = ? AND recipient_device_id = ?
		ORDER BY created_at DESC`

	rows, err := r.db.QueryContext(ctx, query, channelID, recipientUserID, recipientDeviceID)
	if err != nil {
		return nil, fmt.Errorf("failed to get sender key envelopes: %w", err)
	}
	defer rows.Close()

	var envelopes []models.SenderKeyEnvelopeResponse
	for rows.Next() {
		var e models.SenderKeyEnvelopeResponse
		if err := rows.Scan(
			&e.SenderUserID, &e.SenderDeviceID, &e.SessionID, &e.Version,
			&e.MessageType, &e.Ciphertext, &e.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("failed to scan sender key envelope: %w", err)
		}
		envelopes = append(envelopes, e)
	}
	return envelopes, rows.Err()
}

// DeleteByChannel removes all sender key envelopes for a channel (used during key rotation).
func (r *sqliteGroupSessionRepo) DeleteByChannel(ctx context.Context, channelID string) error {
	query := `DELETE FROM channel_sender_key_envelopes WHERE channel_id = ?`
	_, err := r.db.ExecContext(ctx, query, channelID)
	if err != nil {
		return fmt.Errorf("failed to delete channel sender key envelopes: %w", err)
	}
	return nil
}

// DeleteByUser removes a user's envelopes (as sender) from a channel (kick/ban invalidation).
func (r *sqliteGroupSessionRepo) DeleteByUser(ctx context.Context, channelID, userID string) error {
	query := `DELETE FROM channel_sender_key_envelopes WHERE channel_id = ? AND sender_user_id = ?`
	_, err := r.db.ExecContext(ctx, query, channelID, userID)
	if err != nil {
		return fmt.Errorf("failed to delete user sender key envelopes: %w", err)
	}
	return nil
}

var _ GroupSessionRepository = (*sqliteGroupSessionRepo)(nil)
