package repository

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

type MusicSessionRepository interface {
	List(context.Context) ([]models.MusicSession, error)
	Save(context.Context, models.MusicSession) error
	Delete(context.Context, string) error
}

type sqliteMusicSessionRepo struct{ db database.TxQuerier }

func NewSQLiteMusicSessionRepo(db database.TxQuerier) MusicSessionRepository {
	return &sqliteMusicSessionRepo{db: db}
}

func (r *sqliteMusicSessionRepo) List(ctx context.Context) ([]models.MusicSession, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT s.channel_id,s.server_id,s.queue_json,s.repeat_mode,s.revision,COALESCE(h.session_id,'') FROM music_sessions s LEFT JOIN music_control_heads h ON h.channel_id=s.channel_id ORDER BY s.updated_at,s.channel_id`)
	if err != nil {
		return nil, fmt.Errorf("list music sessions: %w", err)
	}
	defer rows.Close()
	result := make([]models.MusicSession, 0)
	for rows.Next() {
		var session models.MusicSession
		var raw string
		if err := rows.Scan(&session.ChannelID, &session.ServerID, &raw, &session.RepeatMode, &session.Revision, &session.SessionID); err != nil {
			return nil, fmt.Errorf("scan music session: %w", err)
		}
		if err := json.Unmarshal([]byte(raw), &session.Queue); err != nil {
			return nil, fmt.Errorf("decode music session %s: %w", session.ChannelID, err)
		}
		result = append(result, session)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate music sessions: %w", err)
	}
	return result, nil
}

func (r *sqliteMusicSessionRepo) Save(ctx context.Context, session models.MusicSession) error {
	raw, err := json.Marshal(session.Queue)
	if err != nil {
		return fmt.Errorf("encode music session: %w", err)
	}
	_, err = r.db.ExecContext(ctx, `INSERT INTO music_sessions(channel_id,server_id,queue_json,repeat_mode,revision,updated_at)
		VALUES(?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(channel_id) DO UPDATE SET server_id=excluded.server_id,queue_json=excluded.queue_json,repeat_mode=excluded.repeat_mode,revision=excluded.revision,updated_at=CURRENT_TIMESTAMP`,
		session.ChannelID, session.ServerID, string(raw), session.RepeatMode, session.Revision)
	if err != nil {
		return fmt.Errorf("save music session: %w", err)
	}
	return nil
}

func (r *sqliteMusicSessionRepo) Delete(ctx context.Context, channelID string) error {
	if _, err := r.db.ExecContext(ctx, `DELETE FROM music_sessions WHERE channel_id=?`, channelID); err != nil {
		return fmt.Errorf("delete music session: %w", err)
	}
	return nil
}
