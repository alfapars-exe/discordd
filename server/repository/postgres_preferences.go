package repository

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func decodePreferenceObject(raw []byte) (map[string]any, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("preferences must be a JSON object")
	}
	return object, nil
}
func mergePreferenceObject(dst, patch map[string]any) {
	for key, value := range patch {
		if value == nil {
			delete(dst, key)
			continue
		}
		if object, ok := value.(map[string]any); ok {
			current, ok := dst[key].(map[string]any)
			if !ok {
				current = map[string]any{}
			}
			mergePreferenceObject(current, object)
			dst[key] = current
		} else {
			dst[key] = value
		}
	}
}
func (r *sqlitePreferencesRepo) upsertPostgres(ctx context.Context, userID string, partial json.RawMessage) (*models.UserPreferences, error) {
	if err := (&models.UpdatePreferencesRequest{Data: partial}).Validate(); err != nil {
		return nil, fmt.Errorf("invalid preferences data: %w", pkg.ErrBadRequest)
	}
	filtered, err := models.FilterDeviceLocalPreferences(partial)
	if err != nil {
		return nil, err
	}
	if len(filtered) > models.MaxPreferencesStoredBytes {
		return nil, fmt.Errorf("preferences storage limit exceeded: %w", pkg.ErrBadRequest)
	}
	patch, err := decodePreferenceObject(filtered)
	if err != nil {
		return nil, err
	}
	var result models.UserPreferences
	err = database.WithTx(ctx, database.RawDB(r.db), func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `INSERT INTO user_preferences(user_id,data) VALUES(?,'{}') ON CONFLICT(user_id) DO NOTHING`, userID); err != nil {
			return err
		}
		var stored string
		if err := tx.QueryRowContext(ctx, `SELECT data FROM user_preferences WHERE user_id=? FOR UPDATE`, userID).Scan(&stored); err != nil {
			return err
		}
		object, err := decodePreferenceObject([]byte(stored))
		if err != nil {
			return err
		}
		mergePreferenceObject(object, patch)
		encoded, err := json.Marshal(object)
		if err != nil {
			return err
		}
		encoded, err = models.FilterDeviceLocalPreferences(encoded)
		if err != nil {
			return err
		}
		if len(encoded) > models.MaxPreferencesStoredBytes {
			return fmt.Errorf("preferences storage limit exceeded: %w", pkg.ErrBadRequest)
		}
		var data string
		if err := tx.QueryRowContext(ctx, `UPDATE user_preferences SET data=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=? RETURNING user_id,data,updated_at`, string(encoded), userID).Scan(&result.UserID, &data, &result.UpdatedAt); err != nil {
			return err
		}
		result.Data = json.RawMessage(data)
		result.SchemaVersion = models.PreferencesSchemaVersion
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("upsert preferences: %w", err)
	}
	return &result, nil
}
