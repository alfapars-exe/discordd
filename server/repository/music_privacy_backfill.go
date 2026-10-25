package repository

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/pkg"
)

const musicPrivacyBackfillVersion = "hichat-music-privacy-backfill-v1"

// Cursors contain only internal row identities, never cached profile/media data.
type MusicPrivacyCursor struct {
	QueueAfter   string    `json:"queue_after"`
	ReceiptAfter [3]string `json:"receipt_after"`
	ExportAfter  string    `json:"export_after"`
}
type MusicPrivacyBackfillReport struct {
	Format          string             `json:"format"`
	Cursor          MusicPrivacyCursor `json:"cursor"`
	NextCursor      MusicPrivacyCursor `json:"next_cursor"`
	Limit           int                `json:"limit"`
	SourceHash      string             `json:"source_hash"`
	QueuesScanned   int                `json:"queues_scanned"`
	QueuesChanged   int                `json:"queues_changed"`
	ReceiptsRemoved int                `json:"retired_actor_receipts"`
	ExportsRemoved  int                `json:"retired_user_exports"`
	Done            bool               `json:"done"`
	Applied         bool               `json:"applied"`
}
type musicPrivacyQueueChange struct {
	Channel, Before, After, Server, Session, Repeat, Updated string
	Revision                                                 uint64
}
type musicPrivacyReceiptRow struct {
	Channel, Actor, Request, Session, Hash, Result, Created string
	Revision                                                uint64
}
type musicPrivacyExportRow struct {
	ID, Owner, Status, Created, Expires string
	Payload                             sql.NullString
}
type musicPrivacyBackfillSnapshot struct {
	Cursor   MusicPrivacyCursor
	Limit    int
	Queues   []musicPrivacyQueueChange
	Receipts []musicPrivacyReceiptRow
	Exports  []musicPrivacyExportRow
}

// BackfillMusicPrivacyBatch never applies without a reviewed dry-run digest.
// Limits and independent keysets bound each table scan. The identity lock is
// acquired before reads, as in account retirement and canonical queue writes.
func BackfillMusicPrivacyBatch(ctx context.Context, db database.TxQuerier, cursor MusicPrivacyCursor, limit int, expectedHash string) (*MusicPrivacyBackfillReport, error) {
	if limit < 1 || limit > 100 {
		return nil, pkg.ErrBadRequest
	}
	if expectedHash != "" {
		decoded, err := hex.DecodeString(expectedHash)
		if err != nil || len(decoded) != sha256.Size {
			return nil, pkg.ErrBadRequest
		}
	}
	raw := database.RawDB(db)
	if raw == nil {
		return nil, fmt.Errorf("music privacy backfill requires a transactional database")
	}
	var report *MusicPrivacyBackfillReport
	err := database.WithTx(ctx, raw, func(tx *sql.Tx) error {
		if err := lockMusicIdentityTx(ctx, tx, database.IsPostgres(raw)); err != nil {
			return err
		}
		snapshot, result, err := collectMusicPrivacyBackfill(ctx, tx, cursor, limit)
		if err != nil {
			return err
		}
		encoded, err := json.Marshal(snapshot)
		if err != nil {
			return err
		}
		digest := sha256.Sum256(encoded)
		result.SourceHash = hex.EncodeToString(digest[:])
		if expectedHash != "" {
			if expectedHash != result.SourceHash {
				return fmt.Errorf("music privacy source changed; run a new dry run: %w", pkg.ErrConflict)
			}
			for _, row := range snapshot.Queues {
				if row.Before == row.After {
					continue
				}
				changed, err := tx.ExecContext(ctx, `UPDATE music_sessions SET queue_json=? WHERE channel_id=? AND queue_json=?`, row.After, row.Channel, row.Before)
				if err := musicPrivacyCAS(changed, err); err != nil {
					return err
				}
			}
			for _, row := range snapshot.Receipts {
				changed, err := tx.ExecContext(ctx, `DELETE FROM music_operation_receipts WHERE channel_id=? AND actor_id=? AND request_id=? AND session_id=? AND request_hash=? AND expected_revision=? AND result_json=? AND EXISTS(SELECT 1 FROM users WHERE id=? AND deleted_at IS NOT NULL)`, row.Channel, row.Actor, row.Request, row.Session, row.Hash, row.Revision, row.Result, row.Actor)
				if err := musicPrivacyCAS(changed, err); err != nil {
					return err
				}
			}
			for _, row := range snapshot.Exports {
				var payload any
				if row.Payload.Valid {
					payload = row.Payload.String
				}
				changed, err := tx.ExecContext(ctx, `DELETE FROM data_exports WHERE id=? AND user_id=? AND payload IS NOT DISTINCT FROM ? AND EXISTS(SELECT 1 FROM users WHERE id=? AND deleted_at IS NOT NULL)`, row.ID, row.Owner, payload, row.Owner)
				if err := musicPrivacyCAS(changed, err); err != nil {
					return err
				}
			}
			result.Applied = true
		}
		report = result
		return nil
	})
	return report, err
}
func musicPrivacyCAS(result sql.Result, err error) error {
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return fmt.Errorf("music privacy row changed: %w", pkg.ErrConflict)
	}
	return nil
}

func collectMusicPrivacyBackfill(ctx context.Context, tx *sql.Tx, cursor MusicPrivacyCursor, limit int) (*musicPrivacyBackfillSnapshot, *MusicPrivacyBackfillReport, error) {
	snapshot := &musicPrivacyBackfillSnapshot{Cursor: cursor, Limit: limit, Queues: []musicPrivacyQueueChange{}, Receipts: []musicPrivacyReceiptRow{}, Exports: []musicPrivacyExportRow{}}
	result := &MusicPrivacyBackfillReport{Format: musicPrivacyBackfillVersion, Cursor: cursor, NextCursor: cursor, Limit: limit, Done: true}
	totalBytes := 0
	rows, err := tx.QueryContext(ctx, `SELECT s.channel_id,s.queue_json,s.server_id,s.repeat_mode,s.revision,s.updated_at,COALESCE(h.session_id,'') FROM music_sessions s LEFT JOIN music_control_heads h ON h.channel_id=s.channel_id WHERE s.channel_id>? ORDER BY s.channel_id LIMIT ?`, cursor.QueueAfter, limit+1)
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var row musicPrivacyQueueChange
		if err := rows.Scan(&row.Channel, &row.Before, &row.Server, &row.Repeat, &row.Revision, &row.Updated, &row.Session); err != nil {
			rows.Close()
			return nil, nil, err
		}
		if len(snapshot.Queues) == limit {
			result.Done = false
			break
		}
		totalBytes += len(row.Before)
		if totalBytes > 64<<20 {
			rows.Close()
			return nil, nil, fmt.Errorf("music privacy batch exceeds bounded review size")
		}
		snapshot.Queues = append(snapshot.Queues, row)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, nil, err
	}
	for i := range snapshot.Queues {
		row := &snapshot.Queues[i]
		// A normal queue has at most 200 pending plus one interrupted current item.
		// Oversized/corrupt legacy data requires separate review, never truncation.
		if len(row.Before) > 2<<20 {
			return nil, nil, fmt.Errorf("music privacy queue exceeds bounded review size")
		}
		var entries []map[string]json.RawMessage
		if err := json.Unmarshal([]byte(row.Before), &entries); err != nil {
			return nil, nil, fmt.Errorf("malformed music privacy queue: %w", err)
		}
		if len(entries) > 201 {
			return nil, nil, fmt.Errorf("music privacy queue exceeds bounded entry count")
		}
		row.After = row.Before
		seen := map[string]bool{}
		for _, entry := range entries {
			var owner string
			if json.Unmarshal(entry["requested_by_user_id"], &owner) != nil || owner == "" || seen[owner] {
				continue
			}
			seen[owner] = true
			var retired int
			if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE id=? AND deleted_at IS NOT NULL`, owner).Scan(&retired); err != nil {
				return nil, nil, err
			}
			if retired == 1 {
				next, _, err := stripMusicRequesterJSON(row.After, owner)
				if err != nil {
					return nil, nil, err
				}
				row.After = next
			}
		}
		result.QueuesScanned++
		if row.After != row.Before {
			result.QueuesChanged++
		}
		result.NextCursor.QueueAfter = row.Channel
	}
	r := cursor.ReceiptAfter
	rows, err = tx.QueryContext(ctx, `SELECT m.channel_id,m.actor_id,m.request_id,m.session_id,m.request_hash,m.expected_revision,m.result_json,m.created_at FROM music_operation_receipts m JOIN users u ON u.id=m.actor_id WHERE u.deleted_at IS NOT NULL AND (m.channel_id,m.actor_id,m.request_id)>(?,?,?) ORDER BY m.channel_id,m.actor_id,m.request_id LIMIT ?`, r[0], r[1], r[2], limit+1)
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var row musicPrivacyReceiptRow
		if err := rows.Scan(&row.Channel, &row.Actor, &row.Request, &row.Session, &row.Hash, &row.Revision, &row.Result, &row.Created); err != nil {
			rows.Close()
			return nil, nil, err
		}
		if len(snapshot.Receipts) == limit {
			result.Done = false
			break
		}
		totalBytes += len(row.Result)
		if totalBytes > 64<<20 {
			rows.Close()
			return nil, nil, fmt.Errorf("music privacy batch exceeds bounded review size")
		}
		snapshot.Receipts = append(snapshot.Receipts, row)
		result.NextCursor.ReceiptAfter = [3]string{row.Channel, row.Actor, row.Request}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, nil, err
	}
	result.ReceiptsRemoved = len(snapshot.Receipts)
	rows, err = tx.QueryContext(ctx, `SELECT e.id,e.user_id,e.status,e.payload,e.created_at,e.expires_at FROM data_exports e JOIN users u ON u.id=e.user_id WHERE u.deleted_at IS NOT NULL AND e.id>? ORDER BY e.id LIMIT ?`, cursor.ExportAfter, limit+1)
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var row musicPrivacyExportRow
		if err := rows.Scan(&row.ID, &row.Owner, &row.Status, &row.Payload, &row.Created, &row.Expires); err != nil {
			rows.Close()
			return nil, nil, err
		}
		if len(snapshot.Exports) == limit {
			result.Done = false
			break
		}
		totalBytes += len(row.Payload.String)
		if totalBytes > 64<<20 {
			rows.Close()
			return nil, nil, fmt.Errorf("music privacy batch exceeds bounded review size")
		}
		snapshot.Exports = append(snapshot.Exports, row)
		result.NextCursor.ExportAfter = row.ID
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, nil, err
	}
	result.ExportsRemoved = len(snapshot.Exports)
	return snapshot, result, nil
}
