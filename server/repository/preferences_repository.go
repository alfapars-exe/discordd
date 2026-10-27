package repository

import (
	"context"
	"encoding/json"

	"github.com/argeinfina/hichat/models"
)

// PreferencesRepository persists user preferences (opaque JSON blob per user).
type PreferencesRepository interface {
	// Get returns the user's preferences. Returns empty Data ({}) if no row exists.
	Get(ctx context.Context, userID string) (*models.UserPreferences, error)

	// Upsert atomically merges object leaves into existing preferences; arrays replace.
	// Creates the row if it doesn't exist.
	Upsert(ctx context.Context, userID string, partial json.RawMessage) (*models.UserPreferences, error)
}

// PreferencesBatchReader provides one bounded round trip for fanout workers.
type PreferencesBatchReader interface {
	GetMany(context.Context, []string) (map[string]*models.UserPreferences, error)
}
