package repository

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"reflect"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

const deletedMusicRequesterName = "Deleted User"

// Equality confirmations ignore object key order only. UseNumber preserves
// exact large integers; arrays, unknown fields, types and values remain strict.
func equalMusicQueueJSON(left, right []byte) (bool, error) {
	decode := func(raw []byte) (any, error) {
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.UseNumber()
		var value any
		if err := decoder.Decode(&value); err != nil {
			return nil, err
		}
		var trailing any
		if err := decoder.Decode(&trailing); err != io.EOF {
			if err == nil {
				return nil, fmt.Errorf("multiple music queue JSON values")
			}
			return nil, err
		}
		return value, nil
	}
	a, err := decode(left)
	if err != nil {
		return false, err
	}
	b, err := decode(right)
	if err != nil {
		return false, err
	}
	return reflect.DeepEqual(a, b), nil
}

// Music identity writes share the existing account-retirement boundary. It is
// acquired before head/queue locks, never while holding a users row write lock.
func lockMusicIdentityTx(ctx context.Context, tx *sql.Tx, postgres bool) error {
	if !postgres {
		_, err := tx.ExecContext(ctx, `UPDATE music_sessions SET revision=revision WHERE 0=1`)
		return err
	}
	_, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(7341982002)`)
	return err
}

func sanitizeMusicTracks(ctx context.Context, q database.TxQuerier, postgres bool, tracks []models.MusicTrack) ([]models.MusicTrack, error) {
	ids := make([]string, 0)
	seen := map[string]bool{}
	for _, track := range tracks {
		if track.RequestedByUserID != "" && !seen[track.RequestedByUserID] {
			seen[track.RequestedByUserID] = true
			ids = append(ids, track.RequestedByUserID)
		}
	}
	result := append([]models.MusicTrack(nil), tracks...)
	if len(ids) == 0 {
		return result, nil
	}
	raw, err := json.Marshal(ids)
	if err != nil {
		return nil, err
	}
	query := `SELECT id FROM users WHERE deleted_at IS NOT NULL AND id IN (SELECT value FROM json_each(?))`
	if postgres {
		query = `SELECT id FROM users WHERE deleted_at IS NOT NULL AND id IN (SELECT jsonb_array_elements_text(CAST(? AS jsonb)))`
	}
	rows, err := q.QueryContext(ctx, query, string(raw))
	if err != nil {
		return nil, fmt.Errorf("read music requester privacy: %w", err)
	}
	defer rows.Close()
	retired := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		retired[id] = true
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range result {
		if retired[result[i].RequestedByUserID] {
			result[i].RequestedByName = deletedMusicRequesterName
		}
	}
	return result, nil
}

// SanitizeMusicTracks supplies the same canonical tombstone names to runtime
// snapshots as durable writes. A failed identity lookup must fail closed.
func (r *sqliteMusicSessionRepo) SanitizeMusicTracks(ctx context.Context, tracks []models.MusicTrack) ([]models.MusicTrack, error) {
	return sanitizeMusicTracks(ctx, r.db, r.postgres, tracks)
}

func requireLiveMusicActor(ctx context.Context, q database.TxQuerier, actor string) error {
	var active int
	if err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE id=? AND deleted_at IS NULL`, actor).Scan(&active); err != nil {
		return err
	}
	if active != 1 {
		return pkg.ErrUnauthorized
	}
	return nil
}

// Legacy enqueue validates actor retirement at the queue-write boundary too.
func (r *sqliteMusicSessionRepo) SaveMusicEnqueue(ctx context.Context, session models.MusicSession, actor string) error {
	db := database.RawDB(r.db)
	if db == nil {
		return fmt.Errorf("music enqueue requires a transactional store")
	}
	return database.WithTx(ctx, db, func(tx *sql.Tx) error {
		if err := lockMusicIdentityTx(ctx, tx, r.postgres); err != nil {
			return err
		}
		if err := requireLiveMusicActor(ctx, tx, actor); err != nil {
			return err
		}
		return (&sqliteMusicSessionRepo{db: tx, postgres: r.postgres}).Save(ctx, session)
	})
}

// stripMusicRequesterJSON changes only the matched cached identity field.
// Unknown media fields and array entries are retained rather than decoding
// through a version-specific MusicTrack struct that could silently drop them.
func stripMusicRequesterJSON(raw, owner string) (string, bool, error) {
	var entries []json.RawMessage
	if err := json.Unmarshal([]byte(raw), &entries); err != nil {
		return "", false, fmt.Errorf("decode music queue for identity retirement: %w", err)
	}
	if entries == nil {
		return raw, false, nil
	}
	changed := false
	for i, entry := range entries {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(entry, &fields); err != nil {
			return "", false, fmt.Errorf("decode music queue entry for identity retirement: %w", err)
		}
		var id string
		if json.Unmarshal(fields["requested_by_user_id"], &id) != nil || id != owner {
			continue
		}
		var name string
		_ = json.Unmarshal(fields["requested_by_name"], &name)
		if name == deletedMusicRequesterName {
			continue
		}
		fields["requested_by_name"] = json.RawMessage(`"Deleted User"`)
		encoded, err := json.Marshal(fields)
		if err != nil {
			return "", false, err
		}
		entries[i] = encoded
		changed = true
	}
	if !changed {
		return raw, false, nil
	}
	encoded, err := json.Marshal(entries)
	return string(encoded), true, err
}

func anonymizeMusicRequesterTx(ctx context.Context, tx *sql.Tx, owner string) error {
	// Human and application callers already own the PG advisory boundary.
	// This no-row write also establishes SQLite's writer boundary before scan.
	if _, err := tx.ExecContext(ctx, `UPDATE music_sessions SET revision=revision WHERE 0=1`); err != nil {
		return err
	}
	rows, err := tx.QueryContext(ctx, `SELECT channel_id,queue_json FROM music_sessions`)
	if err != nil {
		return err
	}
	type update struct{ channelID, raw string }
	updates := []update{}
	for rows.Next() {
		var channel, raw string
		if err := rows.Scan(&channel, &raw); err != nil {
			rows.Close()
			return err
		}
		next, changed, err := stripMusicRequesterJSON(raw, owner)
		if err != nil {
			rows.Close()
			return err
		}
		if changed {
			updates = append(updates, update{channel, next})
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, item := range updates {
		if _, err := tx.ExecContext(ctx, `UPDATE music_sessions SET queue_json=? WHERE channel_id=?`, item.raw, item.channelID); err != nil {
			return err
		}
	}
	return nil
}
