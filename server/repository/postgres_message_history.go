package repository

import (
	"context"
	"github.com/argeinfina/hichat/models"
)

// PostgreSQL history shares the durable order used by read watermarks.
type postgresMessageRepo struct{ *sqliteMessageRepo }

func (r *postgresMessageRepo) GetByChannelID(ctx context.Context, channel, before string, limit int) ([]models.Message, error) {
	query := messageHistorySelect + ` WHERE m.channel_id=?`
	args := []any{channel}
	if before != "" {
		query += ` AND m.source_sequence<(SELECT source_sequence FROM messages WHERE id=? AND channel_id=?)`
		args = append(args, before, channel)
	}
	query += ` ORDER BY m.source_sequence DESC LIMIT ?`
	args = append(args, limit)
	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	return scanRows(rows, "message", scanMessage)
}
func (r *postgresMessageRepo) GetByChannelIDAfter(ctx context.Context, channel, after string, limit int) ([]models.Message, error) {
	if err := r.anchorExists(ctx, channel, after); err != nil {
		return nil, err
	}
	rows, err := r.db.QueryContext(ctx, messageHistorySelect+` WHERE m.channel_id=? AND m.source_sequence>(SELECT source_sequence FROM messages WHERE id=? AND channel_id=?) ORDER BY m.source_sequence LIMIT ?`, channel, after, channel, limit)
	if err != nil {
		return nil, err
	}
	return scanRows(rows, "message", scanMessage)
}
func (r *postgresMessageRepo) GetByChannelIDAround(ctx context.Context, channel, anchor string, limit int) ([]models.Message, bool, bool, error) {
	if err := r.anchorExists(ctx, channel, anchor); err != nil {
		return nil, false, false, err
	}
	half := limit / 2
	rows, err := r.db.QueryContext(ctx, messageHistorySelect+` WHERE m.channel_id=? AND m.source_sequence<=(SELECT source_sequence FROM messages WHERE id=? AND channel_id=?) ORDER BY m.source_sequence DESC LIMIT ?`, channel, anchor, channel, half+2)
	if err != nil {
		return nil, false, false, err
	}
	older, err := scanRows(rows, "message", scanMessage)
	if err != nil {
		return nil, false, false, err
	}
	hasBefore := len(older) > half+1
	if hasBefore {
		older = older[:half+1]
	}
	newer, err := r.GetByChannelIDAfter(ctx, channel, anchor, half+1)
	if err != nil {
		return nil, false, false, err
	}
	hasAfter := len(newer) > half
	if hasAfter {
		newer = newer[:half]
	}
	for i, j := 0, len(older)-1; i < j; i, j = i+1, j-1 {
		older[i], older[j] = older[j], older[i]
	}
	return append(older, newer...), hasBefore, hasAfter, nil
}
