package repository

import (
	"bytes"
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
		// Preserve the exact signed two's-complement key used by existing
		// instances; decode signed bytes without an overflowing conversion.
		var lockKey int64
		if err := binary.Read(bytes.NewReader(hash[:8]), binary.BigEndian, &lockKey); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(?)`, lockKey)
		return err
	}
	_, err := tx.ExecContext(ctx, `UPDATE dm_channels SET status=status WHERE user1_id=? AND user2_id=?`, a, b)
	return err
}
