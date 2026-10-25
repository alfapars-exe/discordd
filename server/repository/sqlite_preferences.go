package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

type sqlitePreferencesRepo struct {
	db database.TxQuerier
}

// NewSQLitePreferencesRepo creates a new SQLite-backed PreferencesRepository.
func NewSQLitePreferencesRepo(db database.TxQuerier) PreferencesRepository {
	return &sqlitePreferencesRepo{db: db}
}

func (r *sqlitePreferencesRepo) Get(ctx context.Context, userID string) (*models.UserPreferences, error) {
	row := r.db.QueryRowContext(ctx,
		`SELECT user_id, data, updated_at FROM user_preferences WHERE user_id = ?`,
		userID,
	)

	var p models.UserPreferences
	var dataStr string
	err := row.Scan(&p.UserID, &dataStr, &p.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		// No row — return empty preferences
		return &models.UserPreferences{
			SchemaVersion: models.PreferencesSchemaVersion,
			UserID:        userID,
			Data:          json.RawMessage(`{}`),
		}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read preferences: %w", err)
	}
	p.SchemaVersion = models.PreferencesSchemaVersion
	p.Data, err = models.FilterDeviceLocalPreferences(json.RawMessage(dataStr))
	if err != nil {
		return nil, fmt.Errorf("read preferences: %w", err)
	}
	return &p, nil
}

func (r *sqlitePreferencesRepo) Upsert(ctx context.Context, userID string, partial json.RawMessage) (*models.UserPreferences, error) {
	if database.IsPostgres(r.db) {
		return r.upsertPostgres(ctx, userID, partial)
	}
	if err := (&models.UpdatePreferencesRequest{Data: partial}).Validate(); err != nil {
		return nil, fmt.Errorf("invalid preferences data: %w", pkg.ErrBadRequest)
	}
	filtered, err := models.FilterDeviceLocalPreferences(partial)
	if err != nil {
		return nil, fmt.Errorf("filter preferences: %w", err)
	}
	// Canonical JSON escaping can expand a valid raw patch; bound INSERT too,
	// not only the conflict/update branch below.
	if len(filtered) > models.MaxPreferencesStoredBytes {
		return nil, fmt.Errorf("preferences storage limit exceeded: %w", pkg.ErrBadRequest)
	}

	// SQLite evaluates the merge against the current row under its write lock.
	// Objects merge recursively; arrays replace. No read/modify/write window can
	// lose disjoint leaf updates from concurrent clients. Legacy device-local
	// keys are removed from storage on the next write, even for an unrelated patch.
	// A corrupt/non-object stored document fails instead of being silently reset.
	const merged = `json_remove(json_patch(
		CASE WHEN json_type(user_preferences.data) = 'object'
		THEN user_preferences.data ELSE json('invalid stored preferences') END,
		excluded.data), '$.voice_settings.inputDevice', '$.voice_settings.outputDevice',
		'$.voice_settings.cameraDevice', '$.voice_settings.muteHotkeyGlobal')`
	row := r.db.QueryRowContext(ctx,
		`INSERT INTO user_preferences (user_id, data, updated_at)
		 VALUES (?, ?, CURRENT_TIMESTAMP)
		 ON CONFLICT(user_id) DO UPDATE SET
		   data = `+merged+`,
		   updated_at = CURRENT_TIMESTAMP
		 WHERE length(CAST(`+merged+` AS BLOB)) <= ?
		 RETURNING user_id, data, updated_at`,
		userID, string(filtered), models.MaxPreferencesStoredBytes,
	)
	var p models.UserPreferences
	var dataStr string
	err = row.Scan(&p.UserID, &dataStr, &p.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("preferences storage limit exceeded: %w", pkg.ErrBadRequest)
	}
	if err != nil {
		return nil, fmt.Errorf("upsert preferences: %w", err)
	}
	p.SchemaVersion = models.PreferencesSchemaVersion
	p.Data = json.RawMessage(dataStr)
	return &p, nil
}
