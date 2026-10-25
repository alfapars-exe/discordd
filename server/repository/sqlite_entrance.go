package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

type sqliteEntranceRepo struct {
	db database.TxQuerier
}

func NewSQLiteEntranceRepo(db database.TxQuerier) EntranceRepository {
	return &sqliteEntranceRepo{db: db}
}

// entranceNowText is the 'YYYY-MM-DD HH:MM:SS' UTC text every timestamp
// column of migration 088 stores (§4 #130: never bind a time.Time).
func entranceNowText() string {
	return time.Now().UTC().Format("2006-01-02 15:04:05")
}

// scanEntranceSound reads the column order every user_entrance_sounds
// SELECT below spells out inline: id, user_id, name, file_url,
// duration_ms, size, created_at (trap #96: Scan is positional).
func scanEntranceSound(rs rowScanner) (models.EntranceSound, error) {
	var (
		s         models.EntranceSound
		createdAt string
	)
	if err := rs.Scan(&s.ID, &s.UserID, &s.Name, &s.URL, &s.DurationMs, &s.Size, &createdAt); err != nil {
		return models.EntranceSound{}, err
	}
	s.CreatedAt = dbTextToRFC3339(createdAt)
	return s, nil
}

func (r *sqliteEntranceRepo) CreateSoundWithCap(ctx context.Context, s *models.EntranceSound, maxCount int) error {
	res, err := r.db.ExecContext(ctx,
		`INSERT INTO user_entrance_sounds (id, user_id, name, file_url, duration_ms, size, created_at)
		 SELECT ?, ?, ?, ?, ?, ?, ?
		 WHERE (SELECT COUNT(*) FROM user_entrance_sounds WHERE user_id = ?) < ?`,
		s.ID, s.UserID, s.Name, s.URL, s.DurationMs, s.Size, entranceNowText(),
		s.UserID, maxCount)
	if err != nil {
		return fmt.Errorf("failed to create entrance sound: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to check rows affected: %w", err)
	}
	if n == 0 {
		return models.ErrEntranceLimitReached
	}
	var createdAt string
	if err := r.db.QueryRowContext(ctx, `SELECT created_at FROM user_entrance_sounds WHERE id = ?`, s.ID).Scan(&createdAt); err == nil {
		s.CreatedAt = dbTextToRFC3339(createdAt)
	}
	return nil
}

func (r *sqliteEntranceRepo) GetSound(ctx context.Context, userID, id string) (*models.EntranceSound, error) {
	row := r.db.QueryRowContext(ctx,
		`SELECT id, user_id, name, file_url, duration_ms, size, created_at
		 FROM user_entrance_sounds WHERE id = ? AND user_id = ?`, id, userID)
	s, err := scanEntranceSound(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, models.ErrEntranceSoundNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get entrance sound: %w", err)
	}
	return &s, nil
}

func (r *sqliteEntranceRepo) ListSounds(ctx context.Context, userID string) ([]models.EntranceSound, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT id, user_id, name, file_url, duration_ms, size, created_at
		 FROM user_entrance_sounds WHERE user_id = ? ORDER BY created_at, id`, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to list entrance sounds: %w", err)
	}
	defer rows.Close()
	out := []models.EntranceSound{}
	for rows.Next() {
		s, err := scanEntranceSound(rows)
		if err != nil {
			return nil, fmt.Errorf("failed to scan entrance sound: %w", err)
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to iterate entrance sounds: %w", err)
	}
	return out, nil
}

func (r *sqliteEntranceRepo) RenameSound(ctx context.Context, userID, id, name string) error {
	res, err := r.db.ExecContext(ctx,
		`UPDATE user_entrance_sounds SET name = ? WHERE id = ? AND user_id = ?`, name, id, userID)
	if err != nil {
		return fmt.Errorf("failed to rename entrance sound: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to check rows affected: %w", err)
	}
	if n == 0 {
		return models.ErrEntranceSoundNotFound
	}
	return nil
}

func (r *sqliteEntranceRepo) DeleteSound(ctx context.Context, userID, id string) (string, error) {
	sqlDB := database.RawDB(r.db)
	if sqlDB == nil {
		return "", fmt.Errorf("DeleteSound requires *sql.DB to start transaction")
	}
	var fileURL string
	err := database.WithTx(ctx, sqlDB, func(tx *sql.Tx) error {
		err := tx.QueryRowContext(ctx,
			`SELECT file_url FROM user_entrance_sounds WHERE id = ? AND user_id = ?`, id, userID).Scan(&fileURL)
		if errors.Is(err, sql.ErrNoRows) {
			return models.ErrEntranceSoundNotFound
		}
		if err != nil {
			return fmt.Errorf("failed to read entrance sound: %w", err)
		}
		// Selection rows first: the FK cascade never fires on Turso.
		if _, err := tx.ExecContext(ctx,
			`DELETE FROM user_entrance_selection WHERE user_id = ? AND sound_id = ?`, userID, id); err != nil {
			return fmt.Errorf("failed to delete entrance selections for sound: %w", err)
		}
		if _, err := tx.ExecContext(ctx,
			`DELETE FROM user_entrance_sounds WHERE id = ? AND user_id = ?`, id, userID); err != nil {
			return fmt.Errorf("failed to delete entrance sound: %w", err)
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	return fileURL, nil
}

func (r *sqliteEntranceRepo) FileURLsByUser(ctx context.Context, userID string) ([]string, error) {
	return r.queryStrings(ctx, "entrance sound urls",
		`SELECT file_url FROM user_entrance_sounds WHERE user_id = ?`, userID)
}

// scanEntranceSelection reads: user_id, scope_server_id, kind, sound_id,
// preset, updated_at.
func scanEntranceSelection(rs rowScanner) (models.EntranceSelectionRow, error) {
	var (
		row       models.EntranceSelectionRow
		soundID   sql.NullString
		preset    sql.NullString
		updatedAt string
	)
	if err := rs.Scan(&row.UserID, &row.ScopeServerID, &row.Kind, &soundID, &preset, &updatedAt); err != nil {
		return models.EntranceSelectionRow{}, err
	}
	if soundID.Valid {
		row.SoundID = &soundID.String
	}
	if preset.Valid {
		row.Preset = &preset.String
	}
	row.UpdatedAt = dbTextToRFC3339(updatedAt)
	return row, nil
}

func (r *sqliteEntranceRepo) ListSelections(ctx context.Context, userID string) ([]models.EntranceSelectionRow, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT user_id, scope_server_id, kind, sound_id, preset, updated_at
		 FROM user_entrance_selection WHERE user_id = ? ORDER BY scope_server_id`, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to list entrance selections: %w", err)
	}
	defer rows.Close()
	out := []models.EntranceSelectionRow{}
	for rows.Next() {
		sel, err := scanEntranceSelection(rows)
		if err != nil {
			return nil, fmt.Errorf("failed to scan entrance selection: %w", err)
		}
		out = append(out, sel)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to iterate entrance selections: %w", err)
	}
	return out, nil
}

func (r *sqliteEntranceRepo) UpsertSelection(ctx context.Context, row *models.EntranceSelectionRow) error {
	if _, err := r.db.ExecContext(ctx,
		`INSERT INTO user_entrance_selection (user_id, scope_server_id, kind, sound_id, preset, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(user_id, scope_server_id) DO UPDATE SET
		   kind = excluded.kind, sound_id = excluded.sound_id,
		   preset = excluded.preset, updated_at = excluded.updated_at`,
		row.UserID, row.ScopeServerID, row.Kind, row.SoundID, row.Preset, entranceNowText()); err != nil {
		return fmt.Errorf("failed to save entrance selection: %w", err)
	}
	return nil
}

func (r *sqliteEntranceRepo) DeleteSelection(ctx context.Context, userID, scopeServerID string) error {
	if _, err := r.db.ExecContext(ctx,
		`DELETE FROM user_entrance_selection WHERE user_id = ? AND scope_server_id = ?`, userID, scopeServerID); err != nil {
		return fmt.Errorf("failed to delete entrance selection: %w", err)
	}
	return nil
}

func (r *sqliteEntranceRepo) ResolveSelection(ctx context.Context, userID, serverID string) (*models.ResolvedEntrance, error) {
	var (
		res      models.ResolvedEntrance
		soundID  sql.NullString
		soundURL sql.NullString
		duration sql.NullInt64
		preset   sql.NullString
	)
	// '' (global) sorts before any server id, so DESC puts the server row
	// first. A clip row whose clip is gone (or belongs to someone else) is
	// skipped, letting the global row apply instead.
	err := r.db.QueryRowContext(ctx,
		`SELECT sel.kind, sel.sound_id, snd.file_url, snd.duration_ms, sel.preset
		 FROM user_entrance_selection sel
		 LEFT JOIN user_entrance_sounds snd ON snd.id = sel.sound_id AND snd.user_id = sel.user_id
		 WHERE sel.user_id = ? AND sel.scope_server_id IN (?, '')
		   AND (sel.kind = 'preset' OR snd.id IS NOT NULL)
		 ORDER BY sel.scope_server_id DESC
		 LIMIT 1`, userID, serverID).Scan(&res.Kind, &soundID, &soundURL, &duration, &preset)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to resolve entrance selection: %w", err)
	}
	res.SoundID = soundID.String
	res.SoundURL = soundURL.String
	res.DurationMs = int(duration.Int64)
	res.Preset = preset.String
	return &res, nil
}

func (r *sqliteEntranceRepo) GetServerSettings(ctx context.Context, serverID string) (*models.ServerEntranceSettings, error) {
	s := &models.ServerEntranceSettings{
		ServerID:           serverID,
		Enabled:            true,
		MaxDurationMs:      models.EntranceMaxDurationMs,
		DisabledChannelIDs: []string{},
	}
	var enabled int
	err := r.db.QueryRowContext(ctx,
		`SELECT enabled, max_duration_ms FROM server_entrance_settings WHERE server_id = ?`, serverID).
		Scan(&enabled, &s.MaxDurationMs)
	if errors.Is(err, sql.ErrNoRows) {
		return s, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get entrance settings: %w", err)
	}
	s.Enabled = enabled != 0
	return s, nil
}

func (r *sqliteEntranceRepo) PatchServerSettings(ctx context.Context, serverID string, enabled *bool, maxDurationMs *int) error {
	var enabledArg any
	if enabled != nil {
		enabledArg = boolInt(*enabled)
	}
	var maxArg any
	if maxDurationMs != nil {
		maxArg = *maxDurationMs
	}
	if _, err := r.db.ExecContext(ctx,
		`INSERT INTO server_entrance_settings (server_id, enabled, max_duration_ms, updated_at)
		 VALUES (?, COALESCE(?, 1), COALESCE(?, 5000), ?)
		 ON CONFLICT(server_id) DO UPDATE SET
		   enabled = COALESCE(?, server_entrance_settings.enabled),
		   max_duration_ms = COALESCE(?, server_entrance_settings.max_duration_ms),
		   updated_at = excluded.updated_at`,
		serverID, enabledArg, maxArg, entranceNowText(), enabledArg, maxArg); err != nil {
		return fmt.Errorf("failed to save entrance settings: %w", err)
	}
	return nil
}

func (r *sqliteEntranceRepo) ListDisabledChannels(ctx context.Context, serverID string) ([]string, error) {
	return r.queryStrings(ctx, "disabled entrance channels",
		`SELECT channel_id FROM channel_entrance_disabled WHERE server_id = ? ORDER BY channel_id`, serverID)
}

func (r *sqliteEntranceRepo) SetChannelDisabled(ctx context.Context, serverID, channelID string, disabled bool) error {
	var err error
	if disabled {
		_, err = r.db.ExecContext(ctx,
			`INSERT INTO channel_entrance_disabled (channel_id, server_id, created_at) VALUES (?, ?, ?)
			 ON CONFLICT(channel_id) DO NOTHING`, channelID, serverID, entranceNowText())
	} else {
		_, err = r.db.ExecContext(ctx,
			`DELETE FROM channel_entrance_disabled WHERE channel_id = ? AND server_id = ?`, channelID, serverID)
	}
	if err != nil {
		return fmt.Errorf("failed to set channel entrance switch: %w", err)
	}
	return nil
}

func (r *sqliteEntranceRepo) IsChannelDisabled(ctx context.Context, channelID string) (bool, error) {
	return r.exists(ctx, "channel entrance switch",
		`SELECT EXISTS(SELECT 1 FROM channel_entrance_disabled WHERE channel_id = ?)`, channelID)
}

func (r *sqliteEntranceRepo) ListMutes(ctx context.Context, serverID string) ([]string, error) {
	return r.queryStrings(ctx, "entrance mutes",
		`SELECT user_id FROM server_entrance_mutes WHERE server_id = ? ORDER BY created_at, user_id`, serverID)
}

func (r *sqliteEntranceRepo) SetMute(ctx context.Context, serverID, userID string, muted bool) error {
	var err error
	if muted {
		_, err = r.db.ExecContext(ctx,
			`INSERT INTO server_entrance_mutes (server_id, user_id, created_at) VALUES (?, ?, ?)
			 ON CONFLICT(server_id, user_id) DO NOTHING`, serverID, userID, entranceNowText())
	} else {
		_, err = r.db.ExecContext(ctx,
			`DELETE FROM server_entrance_mutes WHERE server_id = ? AND user_id = ?`, serverID, userID)
	}
	if err != nil {
		return fmt.Errorf("failed to set entrance mute: %w", err)
	}
	return nil
}

func (r *sqliteEntranceRepo) IsMuted(ctx context.Context, serverID, userID string) (bool, error) {
	return r.exists(ctx, "entrance mute",
		`SELECT EXISTS(SELECT 1 FROM server_entrance_mutes WHERE server_id = ? AND user_id = ?)`, serverID, userID)
}

// queryStrings runs a single-TEXT-column query and returns its values
// (never nil).
func (r *sqliteEntranceRepo) queryStrings(ctx context.Context, what, query string, args ...any) ([]string, error) {
	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to list %s: %w", what, err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			return nil, fmt.Errorf("failed to scan %s: %w", what, err)
		}
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to iterate %s: %w", what, err)
	}
	return out, nil
}

func (r *sqliteEntranceRepo) exists(ctx context.Context, what, query string, args ...any) (bool, error) {
	var n int
	if err := r.db.QueryRowContext(ctx, query, args...).Scan(&n); err != nil {
		return false, fmt.Errorf("failed to check %s: %w", what, err)
	}
	return n != 0, nil
}
