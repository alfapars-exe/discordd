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

// cosmeticFileURLPattern is the exact shape of a server-written raster
// frame file ("/api/uploads/cosmetics/{16 hex}.png|.gif", Faz G2). Anchored
// on both ends - a prefix check alone would let "cosmetics/../x" through,
// which SafeJoin does not stop as long as it stays inside uploadDir
// (trap #247).
var cosmeticFileURLPattern = regexp.MustCompile(`^/api/uploads/cosmetics/[a-f0-9]{16}\.(png|gif)$`)

// repairOrphanedCosmetics removes cosmetics rows whose owner is gone -
// server deletes and user hard-deletes on Turso, where the declared ON
// DELETE CASCADE never fires, or paths that predate the explicit cleanup:
//
//  1. server items whose server no longer exists, together with the slots
//     and grants pointing at them, then their raster files. An item with a
//     file is only removed when uploadDir is set, so its row keeps pointing
//     at the file until a run that can delete it (same rule as
//     repairOrphanedEntranceSounds). A file_url that does not match the
//     generated shape exactly keeps its file.
//  2. slots, grants and plain switches whose user, item or scope server no
//     longer exists.
//
// Built-in items (server_id NULL) are never touched.
func repairOrphanedCosmetics(db *database.DB, uploadDir string) {
	ctx := context.Background()

	rows, err := db.Conn.QueryContext(ctx, `SELECT id, file_url, animated_url FROM cosmetic_items
		WHERE server_id IS NOT NULL
		  AND NOT EXISTS (SELECT 1 FROM servers s WHERE s.id = cosmetic_items.server_id)`)
	if err != nil {
		startupLogger.Warn("orphaned-cosmetic scan failed", "err", pkg.ErrText(err))
		return
	}
	type orphan struct {
		id    string
		files []string
	}
	var orphans []orphan
	for rows.Next() {
		var (
			o                    orphan
			fileURL, animatedURL *string
		)
		if err := rows.Scan(&o.id, &fileURL, &animatedURL); err != nil {
			startupLogger.Warn("orphaned-cosmetic scan row failed", "err", pkg.ErrText(err))
			continue
		}
		for _, u := range []*string{fileURL, animatedURL} {
			if u != nil && *u != "" {
				o.files = append(o.files, *u)
			}
		}
		orphans = append(orphans, o)
	}
	scanErr := rows.Err()
	_ = rows.Close()
	if scanErr != nil {
		startupLogger.Warn("orphaned-cosmetic scan iteration failed", "err", pkg.ErrText(scanErr))
		return
	}

	removed := 0
	for _, o := range orphans {
		if len(o.files) > 0 && uploadDir == "" {
			continue
		}
		if !deleteOrphanedCosmeticItem(ctx, db, o.id) {
			continue
		}
		removed++
		for _, u := range o.files {
			removeOrphanedCosmeticFile(uploadDir, o.id, u)
		}
	}
	if removed > 0 {
		startupLogger.Info("repaired orphaned cosmetic item(s) (deleted server)", "rows", removed)
	}

	for _, s := range []struct{ what, query string }{
		{"equipped", `DELETE FROM user_equipped
			WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = user_equipped.user_id)
			   OR NOT EXISTS (SELECT 1 FROM cosmetic_items ci WHERE ci.id = user_equipped.item_id)
			   OR (scope_server_id <> ''
			       AND NOT EXISTS (SELECT 1 FROM servers s WHERE s.id = user_equipped.scope_server_id))`},
		{"grant", `DELETE FROM user_cosmetics
			WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = user_cosmetics.user_id)
			   OR NOT EXISTS (SELECT 1 FROM cosmetic_items ci WHERE ci.id = user_cosmetics.item_id)
			   OR NOT EXISTS (SELECT 1 FROM servers s WHERE s.id = user_cosmetics.server_id)`},
		{"plain-server", `DELETE FROM user_cosmetic_plain_servers
			WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = user_cosmetic_plain_servers.user_id)
			   OR NOT EXISTS (SELECT 1 FROM servers s WHERE s.id = user_cosmetic_plain_servers.server_id)`},
	} {
		res, err := db.Conn.ExecContext(ctx, s.query)
		if err != nil {
			startupLogger.Warn("orphaned-cosmetic row purge failed", "table", s.what, "err", pkg.ErrText(err))
			continue
		}
		if n, err := res.RowsAffected(); err == nil && n > 0 {
			startupLogger.Info("repaired orphaned cosmetic row(s)", "table", s.what, "rows", n)
		}
	}
}

// deleteOrphanedCosmeticItem removes the slots and grants pointing at item
// id (no cascade on Turso), then the item row. false when a step failed.
func deleteOrphanedCosmeticItem(ctx context.Context, db *database.DB, id string) bool {
	for _, q := range []string{
		`DELETE FROM user_equipped WHERE item_id = ?`,
		`DELETE FROM user_cosmetics WHERE item_id = ?`,
		`DELETE FROM cosmetic_items WHERE id = ?`,
	} {
		if _, err := db.Conn.ExecContext(ctx, q, id); err != nil {
			startupLogger.Warn("orphaned-cosmetic row delete failed", "id", id, "err", pkg.ErrText(err))
			return false
		}
	}
	return true
}

// removeOrphanedCosmeticFile deletes the file behind fileURL, but only when
// the URL has exactly the generated shape.
func removeOrphanedCosmeticFile(uploadDir, id, fileURL string) {
	if !cosmeticFileURLPattern.MatchString(fileURL) {
		startupLogger.Warn("orphaned-cosmetic file_url has an unexpected shape, file left", "id", id)
		return
	}
	full, err := pkg.SafeJoin(uploadDir, strings.TrimPrefix(fileURL, "/api/uploads/"))
	if err != nil {
		startupLogger.Warn("refusing to remove cosmetic file outside upload dir", "id", id, "err", pkg.ErrText(err))
		return
	}
	if err := os.Remove(full); err != nil && !errors.Is(err, fs.ErrNotExist) {
		startupLogger.Warn("failed to remove orphaned cosmetic file", "id", id, "err", pkg.ErrText(err))
	}
}
