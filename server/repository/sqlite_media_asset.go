package repository

// Invariant shared with sqlite_attachment.go and handlers/upload_download.go:
// this lookup runs as a SQLite TEXT comparison, which is BINARY collation by
// default (case-sensitive, byte-exact) — but the file is read back from disk
// with os.Open, and the prod container is Linux, where the filesystem is also
// case-sensitive. Keep both sides byte-exact; do not add COLLATE NOCASE here
// without also relaxing the filesystem lookup.

import (
	"context"
	"fmt"

	"github.com/argeinfina/hichat/database"
)

type sqliteMediaAssetRepo struct {
	db database.TxQuerier
}

func NewSQLiteMediaAssetRepo(db database.TxQuerier) MediaAssetRepository {
	return &sqliteMediaAssetRepo{db: db}
}

// IsPublicAsset checks fileURL against every public-facing media column in a
// single round trip: users.avatar_url|wallpaper_url|avatar_animated_url|
// banner_url (the last two from migration 085, written by the animated-avatar
// and profile-banner uploads) and servers.icon_url|banner_url. servers.
// banner_url is included even though no Go code writes it yet (the column
// exists via migration 063_server_banner.sql, unused today) so a future
// server-banner uploader doesn't silently 404 through this lookup. Server
// custom emojis (migration 086) are public too: server_emojis.file_url |
// animated_url, and so are server stickers (migration 087):
// server_stickers.file_url | animated_url. These are row lookups, not
// "emojis/" / "stickers/" prefix rules, so a deleted emoji's or sticker's
// file stops being served the moment its row is gone even if the file is
// still on disk. Users' entrance-sound clips (migration 088,
// user_entrance_sounds.file_url) follow the same DB-row rule — an <audio>
// element cannot send a Bearer token, and there is no "entrance/" prefix rule.
func (r *sqliteMediaAssetRepo) IsPublicAsset(ctx context.Context, fileURL string) (bool, error) {
	query := `
		SELECT EXISTS(SELECT 1 FROM users WHERE avatar_url = ? OR wallpaper_url = ? OR avatar_animated_url = ? OR banner_url = ? OR banner_animated_url = ?)
			OR EXISTS(SELECT 1 FROM servers WHERE icon_url = ? OR banner_url = ?)
			OR EXISTS(SELECT 1 FROM server_emojis WHERE file_url = ? OR animated_url = ?)
			OR EXISTS(SELECT 1 FROM server_stickers WHERE file_url = ? OR animated_url = ?)
			OR EXISTS(SELECT 1 FROM user_entrance_sounds WHERE file_url = ?)`

	var exists bool
	if err := r.db.QueryRowContext(ctx, query, fileURL, fileURL, fileURL, fileURL, fileURL, fileURL, fileURL, fileURL, fileURL, fileURL, fileURL, fileURL).Scan(&exists); err != nil {
		return false, fmt.Errorf("failed to check public asset: %w", err)
	}
	return exists, nil
}
