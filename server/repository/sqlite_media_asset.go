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
// single round trip. banner_url is included even though no Go code writes it
// yet (the column exists via migration 063_server_banner.sql, unused today)
// so a future banner uploader doesn't silently 404 through this lookup.
func (r *sqliteMediaAssetRepo) IsPublicAsset(ctx context.Context, fileURL string) (bool, error) {
	query := `
		SELECT EXISTS(SELECT 1 FROM users WHERE avatar_url = ? OR wallpaper_url = ?)
			OR EXISTS(SELECT 1 FROM servers WHERE icon_url = ? OR banner_url = ?)`

	var exists bool
	if err := r.db.QueryRowContext(ctx, query, fileURL, fileURL, fileURL, fileURL).Scan(&exists); err != nil {
		return false, fmt.Errorf("failed to check public asset: %w", err)
	}
	return exists, nil
}
