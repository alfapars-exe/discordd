package repository

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

type SpamInboxRepository struct{ db database.TxQuerier }

func NewSpamInboxRepository(db database.TxQuerier) *SpamInboxRepository {
	return &SpamInboxRepository{db: db}
}

// Record requires the service to verify source read access before calling.
// Retrying the same revision preserves an explicit restore/dismiss decision.
func (r *SpamInboxRepository) Record(ctx context.Context, e *models.SpamInboxEntry) error {
	if err := e.Validate(true); err != nil {
		return fmt.Errorf("%w: %v", pkg.ErrBadRequest, err)
	}
	if e == nil || e.UserID == "" || e.MessageID == "" || e.ChannelID == "" || len(e.Revision) > 64 || len(e.Reasons) == 0 || len(e.Reasons) > 3 {
		return fmt.Errorf("invalid spam reference")
	}
	if e.SourceKind != "channel" && e.SourceKind != "dm" && e.SourceKind != "group" {
		return fmt.Errorf("invalid spam source")
	}
	for _, reason := range e.Reasons {
		if reason != "credential-link" && reason != "mass-mention-links" && reason != "repeated-links" {
			return fmt.Errorf("invalid spam reason")
		}
	}
	reasons, _ := json.Marshal(e.Reasons)
	_, err := r.db.ExecContext(ctx, `INSERT INTO spam_inbox(user_id,source_kind,channel_id,message_id,revision,reasons) VALUES(?,?,?,?,?,?)
 ON CONFLICT(user_id,source_kind,message_id) DO UPDATE SET channel_id=excluded.channel_id,revision=excluded.revision,reasons=excluded.reasons,status='quarantined',updated_at=CURRENT_TIMESTAMP WHERE spam_inbox.revision<>excluded.revision`, e.UserID, e.SourceKind, e.ChannelID, e.MessageID, e.Revision, string(reasons))
	if err != nil && strings.Contains(err.Error(), "spam_inbox_limit") {
		return fmt.Errorf("%w: spam_inbox_limit", pkg.ErrBadRequest)
	}
	return err
}

func (r *SpamInboxRepository) Decide(ctx context.Context, userID, kind, messageID, revision, status string) (bool, error) {
	if status != "restored" && status != "dismissed" {
		return false, fmt.Errorf("invalid spam decision")
	}
	result, err := r.db.ExecContext(ctx, `UPDATE spam_inbox SET status=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND source_kind=? AND message_id=? AND revision=?`, status, userID, kind, messageID, revision)
	if err != nil {
		return false, err
	}
	n, err := result.RowsAffected()
	return n > 0, err
}

func (r *SpamInboxRepository) List(ctx context.Context, userID string, limit int) ([]models.SpamInboxEntry, error) {
	page, err := r.Page(ctx, userID, "", limit)
	if err != nil {
		return nil, err
	}
	return page.Entries, nil
}

func (r *SpamInboxRepository) Page(ctx context.Context, userID, cursor string, limit int) (*models.SpamInboxPage, error) {
	return r.page(ctx, userID, cursor, limit, false)
}
func (r *SpamInboxRepository) Decisions(ctx context.Context, userID, cursor string, limit int) (*models.SpamInboxPage, error) {
	return r.page(ctx, userID, cursor, limit, true)
}
func (r *SpamInboxRepository) page(ctx context.Context, userID, cursor string, limit int, decisions bool) (*models.SpamInboxPage, error) {
	if limit < 1 || limit > 100 {
		limit = 50
	}
	query := `SELECT source_kind,channel_id,message_id,revision,reasons,status,created_at FROM spam_inbox WHERE user_id=?`
	if decisions {
		query += ` AND status IN ('restored','dismissed')`
	} else {
		query += ` AND status='quarantined'`
	}
	args := []any{userID}
	if cursor != "" {
		if len(cursor) > 1024 {
			return nil, pkg.ErrBadRequest
		}
		decoded, err := base64.RawURLEncoding.DecodeString(cursor)
		var anchor []string
		if err != nil || json.Unmarshal(decoded, &anchor) != nil || len(anchor) != 3 {
			return nil, pkg.ErrBadRequest
		}
		query += ` AND (created_at < ? OR (created_at = ? AND (source_kind < ? OR (source_kind = ? AND message_id < ?))))`
		args = append(args, anchor[0], anchor[0], anchor[1], anchor[1], anchor[2])
	}
	query += ` ORDER BY created_at DESC,source_kind DESC,message_id DESC LIMIT ?`
	args = append(args, limit+1)
	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	entries := []models.SpamInboxEntry{}
	for rows.Next() {
		e := models.SpamInboxEntry{UserID: userID}
		var reasons string
		if err := rows.Scan(&e.SourceKind, &e.ChannelID, &e.MessageID, &e.Revision, &reasons, &e.Status, &e.CreatedAt); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(reasons), &e.Reasons); err != nil {
			return nil, err
		}
		entries = append(entries, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	page := &models.SpamInboxPage{Entries: entries}
	if len(entries) > limit {
		page.Entries = entries[:limit]
		last := page.Entries[limit-1]
		encoded, _ := json.Marshal([]string{last.CreatedAt, last.SourceKind, last.MessageID})
		page.NextCursor = base64.RawURLEncoding.EncodeToString(encoded)
	}
	for i := range page.Entries {
		page.Entries[i].CreatedAt = dbTextToRFC3339(page.Entries[i].CreatedAt)
	}
	return page, nil
}
