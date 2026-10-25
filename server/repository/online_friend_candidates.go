package repository

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/argeinfina/hichat/models"
)

// OnlineFriendCandidate is a prefilter snapshot, never an authorization grant.
// CreateIfOnlineFriendEligible still rechecks the live edges and preferences
// under the existing transaction locks immediately before persisting.
type OnlineFriendCandidate struct {
	UserID      string
	Blocked     bool
	Preferences *models.UserPreferences
}

func (r *sqliteNotificationRepo) ListOnlineFriendCandidates(ctx context.Context, actorID string) ([]OnlineFriendCandidate, error) {
	rows, err := r.db.QueryContext(ctx, `WITH candidates AS (
	 SELECT DISTINCT CASE WHEN f.user_id=? THEN f.friend_id ELSE f.user_id END AS user_id
	 FROM friendships f WHERE f.status='accepted' AND (f.user_id=? OR f.friend_id=?)
	) SELECT c.user_id,COALESCE(p.data,'{}'),EXISTS(SELECT 1 FROM friendships b
	 WHERE b.status='blocked' AND ((b.user_id=? AND b.friend_id=c.user_id) OR (b.friend_id=? AND b.user_id=c.user_id)))
	 FROM candidates c LEFT JOIN user_preferences p ON p.user_id=c.user_id`, actorID, actorID, actorID, actorID, actorID)
	if err != nil {
		return nil, fmt.Errorf("online friend candidates: %w", err)
	}
	defer rows.Close()
	var candidates []OnlineFriendCandidate
	for rows.Next() {
		var c OnlineFriendCandidate
		var data string
		if err := rows.Scan(&c.UserID, &data, &c.Blocked); err != nil {
			return nil, err
		}
		c.Preferences = &models.UserPreferences{SchemaVersion: models.PreferencesSchemaVersion, UserID: c.UserID, Data: json.RawMessage(data)}
		candidates = append(candidates, c)
	}
	return candidates, rows.Err()
}
