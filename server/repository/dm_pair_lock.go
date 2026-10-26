package repository

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/binary"
	"encoding/json"
)

// Serialize a relationship that may not have a DM row yet. All callers acquire
// this before DM-row/relationship locks. Hash collisions only serialize extra
// pairs; no authorization decision depends on the hash. SQLite's first write
// reserves the database writer even when the pair has no existing channel.
func lockDMCreationPair(ctx context.Context, tx *sql.Tx, a, b string, postgres bool) error {
	if a > b {
		a, b = b, a
	}
	if postgres {
		encoded, _ := json.Marshal([]string{"hichat.dm.create-block.v1", a, b})
		hash := sha256.Sum256(encoded)
		_, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(?)`, int64(binary.BigEndian.Uint64(hash[:8])))
		return err
	}
	_, err := tx.ExecContext(ctx, `UPDATE dm_channels SET status=status WHERE user1_id=? AND user2_id=?`, a, b)
	return err
}
