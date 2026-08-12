package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

type sqliteAuditLogRepo struct {
	db database.TxQuerier
}

func NewSQLiteAuditLogRepo(db database.TxQuerier) AuditLogRepository {
	return &sqliteAuditLogRepo{db: db}
}

func (r *sqliteAuditLogRepo) Insert(ctx context.Context, entry *models.AuditLog) error {
	// Serialize the snapshots once at write time — we never want to JOIN
	// the users table to read audit entries (would lose history for deleted
	// users + add fanout). The snapshot captures display name + avatar at
	// the moment the event happened, which is what users want to see.
	actorJSON, err := marshalSnapshot(entry.ActorSnapshot)
	if err != nil {
		return fmt.Errorf("marshal actor snapshot: %w", err)
	}
	targetJSON, err := marshalSnapshot(entry.TargetSnapshot)
	if err != nil {
		return fmt.Errorf("marshal target snapshot: %w", err)
	}

	metadata := entry.Metadata
	if metadata == "" {
		metadata = "{}"
	}

	// entry.ID is generated in Go (same 16-hex shape as the DB default) so the
	// audit_log_service can broadcast the row with its canonical id right after
	// insert. Track R was a real bug: an empty ID made every WS audit event
	// after the first collide in the client dedupe-by-id and get dropped, so
	// sequential moderation actions (kick → move → mute) vanished. created_at
	// is read back best-effort. INSERT..RETURNING is avoided so a dropped
	// Turso/Hrana stream can't 500 the write (see retry.go).
	id, err := generateID()
	if err != nil {
		return fmt.Errorf("insert audit log: %w", err)
	}
	entry.ID = id

	query := `
		INSERT INTO audit_logs (
			id, server_id, actor_user_id, target_user_id,
			event_type, metadata, actor_snapshot, target_snapshot
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`

	if _, err = r.db.ExecContext(ctx, query,
		entry.ID, entry.ServerID, entry.ActorUserID, entry.TargetUserID,
		entry.EventType, metadata, actorJSON, targetJSON,
	); err != nil {
		return fmt.Errorf("insert audit log: %w", err)
	}

	// Best-effort read-back of the DB-side default created_at (see sqlite_user.go).
	_ = r.db.QueryRowContext(ctx, "SELECT created_at FROM audit_logs WHERE id = ?", entry.ID).Scan(&entry.CreatedAt)
	return nil
}

func (r *sqliteAuditLogRepo) ListByServer(
	ctx context.Context,
	filter models.AuditLogFilter,
) ([]models.AuditLog, error) {
	limit := filter.Limit
	// Cap raised from 100 → 500 so client.fetchInitial can prefetch a
	// real history (~200 by default) without hitting the ceiling. The
	// (server_id, created_at DESC) index keeps even 500-row scans
	// cheap so there's no downside to letting the moderation UI show
	// more entries by default.
	if limit <= 0 || limit > 500 {
		limit = 50
	}

	// Keyset pagination. The idx_audit_logs_server_created index covers
	// (server_id, created_at DESC) so this stays cheap as the table grows.
	// The cursor is built to match ORDER BY created_at DESC, id DESC:
	//   - BeforeID → keyset on (created_at, id) via BOOLEAN EXPANSION, not a
	//     row-value comparison: row-value isn't portable across the modernc
	//     and libsql/Turso engines (same rationale as sqlite_message.go). The
	//     cursor row's created_at is looked up server-side from its id, so no
	//     client timestamp round-trip can drift the stored format (§4 trap).
	//     A page boundary among rows sharing a created_at (two moderation
	//     actions in the same second) then neither skips nor repeats.
	//   - Before only → legacy created_at < ?, kept so an older client that
	//     sends just `before` keeps paginating (edge-case-prone but unbroken).
	//   - neither → first page.
	// Query fragments are static; only the cursor values are bound.
	where := "server_id = ?"
	args := []any{filter.ServerID}
	switch {
	case filter.BeforeID != nil:
		where += ` AND ( created_at < (SELECT created_at FROM audit_logs WHERE id = ?)
		            OR ( created_at = (SELECT created_at FROM audit_logs WHERE id = ?) AND id < ? ) )`
		args = append(args, *filter.BeforeID, *filter.BeforeID, *filter.BeforeID)
	case filter.Before != nil:
		where += " AND created_at < ?"
		args = append(args, *filter.Before)
	}
	args = append(args, limit)

	query := `
		SELECT id, server_id, actor_user_id, target_user_id,
		       event_type, metadata, actor_snapshot, target_snapshot, created_at
		FROM audit_logs
		WHERE ` + where + `
		ORDER BY created_at DESC, id DESC
		LIMIT ?`

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list audit logs: %w", err)
	}
	defer rows.Close()

	var entries []models.AuditLog
	for rows.Next() {
		var entry models.AuditLog
		var actorJSON, targetJSON sql.NullString
		if err := rows.Scan(
			&entry.ID, &entry.ServerID, &entry.ActorUserID, &entry.TargetUserID,
			&entry.EventType, &entry.Metadata, &actorJSON, &targetJSON, &entry.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan audit log: %w", err)
		}
		entry.ActorSnapshot = unmarshalSnapshot(actorJSON)
		entry.TargetSnapshot = unmarshalSnapshot(targetJSON)
		entries = append(entries, entry)
	}
	return entries, rows.Err()
}

// DeleteBefore removes audit_logs rows older than before, mirroring
// sqliteAppLogRepo.DeleteBefore (same "2006-01-02 15:04:05" cutoff format,
// since audit_logs.created_at uses the same DATETIME DEFAULT (datetime('now'))).
func (r *sqliteAuditLogRepo) DeleteBefore(ctx context.Context, before string) (int64, error) {
	res, err := r.db.ExecContext(ctx, "DELETE FROM audit_logs WHERE created_at < ?", before)
	if err != nil {
		return 0, fmt.Errorf("delete old audit logs: %w", err)
	}
	return res.RowsAffected()
}

// marshalSnapshot serialises a UserSnapshot to JSON, returning NULL sentinel
// when the snapshot is nil so the DB column stays NULL.
func marshalSnapshot(s *models.UserSnapshot) (sql.NullString, error) {
	if s == nil {
		return sql.NullString{}, nil
	}
	b, err := json.Marshal(s)
	if err != nil {
		return sql.NullString{}, err
	}
	return sql.NullString{String: string(b), Valid: true}, nil
}

// unmarshalSnapshot is the inverse — NullString → *UserSnapshot. Malformed
// JSON returns nil; the audit entry still renders with a fallback name on
// the client side, we don't fail the whole query for one bad row.
func unmarshalSnapshot(s sql.NullString) *models.UserSnapshot {
	if !s.Valid || s.String == "" {
		return nil
	}
	var snap models.UserSnapshot
	if err := json.Unmarshal([]byte(s.String), &snap); err != nil {
		return nil
	}
	return &snap
}
