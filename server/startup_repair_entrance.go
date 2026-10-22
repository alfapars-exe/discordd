package main

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"regexp"
	"strings"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/pkg"
)

// entranceFileURLPattern is the exact shape entranceService writes
// ("/api/uploads/entrance/{16 hex}.wav"). Anchored on both ends — a prefix
// check alone would let "entrance/../x" through, which SafeJoin does not
// stop as long as it stays inside uploadDir (§4 #247).
var entranceFileURLPattern = regexp.MustCompile(`^/api/uploads/entrance/[a-f0-9]{16}\.wav$`)

// repairOrphanedEntranceSounds removes entrance clips whose user no longer
// exists (user hard-deletes on Turso, where the declared ON DELETE CASCADE
// never fires, or paths that predate the explicit cleanup) — the row AND its
// file. The clip is only public while its row exists, so the row is deleted
// first and the file removed right after; a file_url that does not match
// the generated shape exactly keeps its file. With no uploadDir nothing is
// deleted at all, so the rows keep pointing at their files until a run that
// can remove them (same rule as repairOrphanedSoundboard).
func repairOrphanedEntranceSounds(db *database.DB, uploadDir string) {
	if uploadDir == "" {
		return
	}
	ctx := context.Background()

	rows, err := db.Conn.QueryContext(ctx, `SELECT id, file_url FROM user_entrance_sounds
		WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = user_entrance_sounds.user_id)`)
	if err != nil {
		startupLogger.Warn("orphaned-entrance-sound scan failed", "err", pkg.ErrText(err))
		return
	}
	type orphan struct{ id, fileURL string }
	var orphans []orphan
	for rows.Next() {
		var o orphan
		if err := rows.Scan(&o.id, &o.fileURL); err != nil {
			startupLogger.Warn("orphaned-entrance-sound scan row failed", "err", pkg.ErrText(err))
			continue
		}
		orphans = append(orphans, o)
	}
	scanErr := rows.Err()
	_ = rows.Close()
	if scanErr != nil {
		startupLogger.Warn("orphaned-entrance-sound scan iteration failed", "err", pkg.ErrText(scanErr))
		return
	}

	removed := 0
	for _, o := range orphans {
		// Selections pointing at the clip go with it (no cascade on Turso).
		if _, err := db.Conn.ExecContext(ctx, `DELETE FROM user_entrance_selection WHERE sound_id = ?`, o.id); err != nil {
			startupLogger.Warn("orphaned-entrance-sound selection delete failed", "id", o.id, "err", pkg.ErrText(err))
			continue
		}
		if _, err := db.Conn.ExecContext(ctx, `DELETE FROM user_entrance_sounds WHERE id = ?`, o.id); err != nil {
			startupLogger.Warn("orphaned-entrance-sound row delete failed", "id", o.id, "err", pkg.ErrText(err))
			continue
		}
		removed++
		if !entranceFileURLPattern.MatchString(o.fileURL) {
			startupLogger.Warn("orphaned-entrance-sound file_url has an unexpected shape, file left", "id", o.id)
			continue
		}
		full, err := pkg.SafeJoin(uploadDir, strings.TrimPrefix(o.fileURL, "/api/uploads/"))
		if err != nil {
			startupLogger.Warn("refusing to remove entrance file outside upload dir", "id", o.id, "err", pkg.ErrText(err))
			continue
		}
		if err := os.Remove(full); err != nil && !errors.Is(err, fs.ErrNotExist) {
			startupLogger.Warn("failed to remove orphaned entrance file", "id", o.id, "err", pkg.ErrText(err))
		}
	}
	if removed > 0 {
		startupLogger.Info("repaired orphaned entrance clip(s) (deleted user)", "rows", removed)
	}
}
