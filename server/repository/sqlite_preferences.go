package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

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

// GetManyStrict is a bounded bulk reader for profile audience checks. Unlike
// notification fanout's tolerant GetMany contract, malformed preferences
// fail the privacy read so they can never default to all_servers.
func (r *sqlitePreferencesRepo) GetManyStrict(ctx context.Context, userIDs []string) (map[string]*models.UserPreferences, error) {
	const batchSize = 400
	result := make(map[string]*models.UserPreferences, len(userIDs))
	unique := make([]string, 0, len(userIDs))
	seen := make(map[string]struct{}, len(userIDs))
	for _, id := range userIDs {
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		unique = append(unique, id)
		result[id] = &models.UserPreferences{SchemaVersion: models.PreferencesSchemaVersion, UserID: id, Data: json.RawMessage(`{}`)}
	}
	for start := 0; start < len(unique); start += batchSize {
		end := start + batchSize
		if end > len(unique) {
			end = len(unique)
		}
		ids := unique[start:end]
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
		rows, err := r.db.QueryContext(ctx,
			`SELECT user_id, data, updated_at FROM user_preferences WHERE user_id IN (`+placeholders+`)`,
			stringArgs(ids)...,
		)
		if err != nil {
			return nil, fmt.Errorf("read preferences batch: %w", err)
		}
		for rows.Next() {
			var id, raw string
			var updatedAt string
			if err := rows.Scan(&id, &raw, &updatedAt); err != nil {
				_ = rows.Close()
				return nil, fmt.Errorf("scan preferences batch: %w", err)
			}
			filtered, err := models.FilterDeviceLocalPreferences(json.RawMessage(raw))
			if err != nil {
				_ = rows.Close()
				return nil, fmt.Errorf("filter preferences batch: %w", err)
			}
			result[id] = &models.UserPreferences{SchemaVersion: models.PreferencesSchemaVersion, UserID: id, Data: filtered, UpdatedAt: updatedAt}
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("iterate preferences batch: %w", err)
		}
		if err := rows.Close(); err != nil {
			return nil, fmt.Errorf("close preferences batch: %w", err)
		}
	}
	return result, nil
}

func stringArgs(values []string) []any {
	args := make([]any, len(values))
	for i := range values {
		args[i] = values[i]
	}
	return args
}

// GetMany tolerates corrupt rows as opt-out so a single bad preference cannot
// poison or starve a notification fanout page. Privacy-sensitive callers must
// use GetManyStrict instead.
func (r *sqlitePreferencesRepo) GetMany(ctx context.Context, userIDs []string) (map[string]*models.UserPreferences, error) {
	out := make(map[string]*models.UserPreferences, len(userIDs))
	if len(userIDs) == 0 {
		return out, nil
	}
	unique := make([]string, 0, len(userIDs))
	seen := make(map[string]struct{}, len(userIDs))
	for _, id := range userIDs {
		if id == "" {
			continue
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		unique = append(unique, id)
	}
	const batchSize = 400
	for start := 0; start < len(unique); start += batchSize {
		end := start + batchSize
		if end > len(unique) {
			end = len(unique)
		}
		ids := unique[start:end]
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
		rows, err := r.db.QueryContext(ctx,
			`SELECT user_id, data, updated_at FROM user_preferences WHERE user_id IN (`+placeholders+`)`,
			stringArgs(ids)...,
		)
		if err != nil {
			return nil, fmt.Errorf("read preferences batch: %w", err)
		}
		for rows.Next() {
			p := &models.UserPreferences{SchemaVersion: models.PreferencesSchemaVersion}
			var raw string
			if err = rows.Scan(&p.UserID, &raw, &p.UpdatedAt); err != nil {
				_ = rows.Close()
				return nil, fmt.Errorf("scan preferences batch: %w", err)
			}
			// A malformed row is opt-out for this recipient. Keep fanout moving.
			if !json.Valid([]byte(raw)) {
				p.Data = json.RawMessage(`{}`)
				out[p.UserID] = p
				continue
			}
			p.Data, err = models.FilterDeviceLocalPreferences(json.RawMessage(raw))
			if err != nil {
				_ = rows.Close()
				return nil, fmt.Errorf("read preferences batch: %w", err)
			}
			out[p.UserID] = p
		}
		if err = rows.Err(); err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("iterate preferences batch: %w", err)
		}
		if err = rows.Close(); err != nil {
			return nil, fmt.Errorf("close preferences batch: %w", err)
		}
	}
	return out, nil
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
	rows, err := r.db.QueryContext(ctx,
		`INSERT INTO user_preferences (user_id, data, updated_at)
		 VALUES (?, ?, CURRENT_TIMESTAMP)
		 ON CONFLICT(user_id) DO UPDATE SET
		   data = `+merged+`,
		   updated_at = CURRENT_TIMESTAMP
		 WHERE length(CAST(`+merged+` AS BLOB)) <= ?
		 RETURNING user_id, data, updated_at`,
		userID, string(filtered), models.MaxPreferencesStoredBytes,
	)
	if err != nil {
		return nil, fmt.Errorf("upsert preferences: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, fmt.Errorf("upsert preferences: %w", err)
		}
		return nil, fmt.Errorf("preferences storage limit exceeded: %w", pkg.ErrBadRequest)
	}
	var p models.UserPreferences
	var dataStr string
	err = rows.Scan(&p.UserID, &dataStr, &p.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("upsert preferences: %w", err)
	}
	// Complete the RETURNING stream before acknowledging the write. The
	// QueryRow path discards its tail after one row; live libSQL concurrency
	// tests observed stale immediate pooled reads on that path. Consuming EOF
	// also surfaces late execution/close errors instead of reporting success.
	if rows.Next() {
		return nil, fmt.Errorf("upsert preferences returned multiple rows")
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("complete preferences write: %w", err)
	}
	p.SchemaVersion = models.PreferencesSchemaVersion
	p.Data = json.RawMessage(dataStr)
	return &p, nil
}
