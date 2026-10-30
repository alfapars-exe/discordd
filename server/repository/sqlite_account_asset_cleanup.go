package repository

import (
	"context"
	"database/sql"
	"fmt"
	"github.com/argeinfina/hichat/database"
)

type AccountAssetCleanupRepository interface {
	Due(context.Context, int64, int) ([]string, error)
	Process(context.Context, string, int64, func() error) (string, error)
}
type sqliteAccountAssetCleanupRepo struct{ db database.TxQuerier }

func NewSQLiteAccountAssetCleanupRepo(db database.TxQuerier) AccountAssetCleanupRepository {
	return &sqliteAccountAssetCleanupRepo{db: db}
}
func (r *sqliteAccountAssetCleanupRepo) Due(ctx context.Context, now int64, limit int) ([]string, error) {
	if limit < 1 || limit > 100 {
		limit = 25
	}
	rows, err := r.db.QueryContext(ctx, "SELECT file_url FROM account_asset_cleanup WHERE completed_at IS NULL AND next_attempt_at<=? ORDER BY requested_at,file_url LIMIT ?", now, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	urls := []string{}
	for rows.Next() {
		var url string
		if err := rows.Scan(&url); err != nil {
			return nil, err
		}
		urls = append(urls, url)
	}
	return urls, rows.Err()
}

// Process commits retirement under the database writer lock before touching
// the filesystem. No rollback can reopen a removed URL for reattachment.
// Failed/crashed removals retain the durable retirement and retry deadline.
func (r *sqliteAccountAssetCleanupRepo) Process(ctx context.Context, url string, now int64, remove func() error) (string, error) {
	raw := database.RawDB(r.db)
	if raw == nil || remove == nil {
		return "", fmt.Errorf("cleanup requires transactional database and remover")
	}
	outcome := "skipped"
	err := database.WithTx(ctx, raw, func(tx *sql.Tx) error {
		if database.IsPostgres(raw) {
			if _, err := tx.ExecContext(ctx, "SELECT pg_advisory_xact_lock(7341982002)"); err != nil {
				return err
			}
		}
		result, err := tx.ExecContext(ctx, "UPDATE account_asset_cleanup SET attempts=attempts+1,next_attempt_at=? WHERE file_url=? AND completed_at IS NULL AND next_attempt_at<=?", now+60, url, now)
		if err != nil {
			return err
		}
		n, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if n != 1 {
			return nil
		}
		var referenced bool
		references := accountAssetReferences
		if database.IsPostgres(raw) {
			references = postgresAccountAssetReferences
		}
		if err := tx.QueryRowContext(ctx, references, url).Scan(&referenced); err != nil {
			return err
		}
		if referenced {
			outcome = "referenced"
			return nil
		}
		if _, err := tx.ExecContext(ctx, "UPDATE account_asset_cleanup SET retired_at=COALESCE(retired_at,?) WHERE file_url=?", now, url); err != nil {
			return err
		}
		outcome = "retired"
		return nil
	})
	if err != nil || outcome != "retired" {
		return outcome, err
	}
	if err := remove(); err != nil {
		return "retry", nil
	}
	if _, err := r.db.ExecContext(ctx, "UPDATE account_asset_cleanup SET completed_at=? WHERE file_url=? AND retired_at IS NOT NULL", now, url); err != nil {
		return "retry", err
	}
	return "removed", nil
}

// Conservative case-insensitive matching also protects aliases on Windows.
const accountAssetReferences = `
 SELECT EXISTS(SELECT 1 FROM users WHERE avatar_url=?1 COLLATE NOCASE OR avatar_animated_url=?1 COLLATE NOCASE OR banner_url=?1 COLLATE NOCASE OR banner_animated_url=?1 COLLATE NOCASE OR wallpaper_url=?1 COLLATE NOCASE)
 OR EXISTS(SELECT 1 FROM servers WHERE icon_url=?1 COLLATE NOCASE OR banner_url=?1 COLLATE NOCASE)
 OR EXISTS(SELECT 1 FROM attachments WHERE file_url=?1 COLLATE NOCASE)
 OR EXISTS(SELECT 1 FROM dm_attachments WHERE file_url=?1 COLLATE NOCASE)
 OR EXISTS(SELECT 1 FROM report_attachments WHERE file_url=?1 COLLATE NOCASE)
 OR EXISTS(SELECT 1 FROM feedback_attachments WHERE file_url=?1 COLLATE NOCASE)
 OR EXISTS(SELECT 1 FROM server_emojis WHERE file_url=?1 COLLATE NOCASE OR animated_url=?1 COLLATE NOCASE)
 OR EXISTS(SELECT 1 FROM server_stickers WHERE file_url=?1 COLLATE NOCASE OR animated_url=?1 COLLATE NOCASE)
 OR EXISTS(SELECT 1 FROM user_entrance_sounds WHERE file_url=?1 COLLATE NOCASE)
 OR EXISTS(SELECT 1 FROM soundboard_sounds WHERE file_url=?1 COLLATE NOCASE)
 OR EXISTS(SELECT 1 FROM badges WHERE icon=?1 COLLATE NOCASE)
 OR EXISTS(SELECT 1 FROM cosmetic_items WHERE file_url=?1 COLLATE NOCASE OR animated_url=?1 COLLATE NOCASE)
 OR EXISTS(SELECT 1 FROM link_previews WHERE image_url=?1 COLLATE NOCASE OR favicon_url=?1 COLLATE NOCASE)
 OR EXISTS(SELECT 1 FROM user_equipped WHERE instr(lower(asset_snapshot),lower(?1))>0)
 `

const postgresAccountAssetReferences = `
 SELECT EXISTS(SELECT 1 FROM users WHERE hichat_ascii_lower(avatar_url)=hichat_ascii_lower(?1) OR hichat_ascii_lower(avatar_animated_url)=hichat_ascii_lower(?1) OR hichat_ascii_lower(banner_url)=hichat_ascii_lower(?1) OR hichat_ascii_lower(banner_animated_url)=hichat_ascii_lower(?1) OR hichat_ascii_lower(wallpaper_url)=hichat_ascii_lower(?1))
 OR EXISTS(SELECT 1 FROM servers WHERE hichat_ascii_lower(icon_url)=hichat_ascii_lower(?1) OR hichat_ascii_lower(banner_url)=hichat_ascii_lower(?1))
 OR EXISTS(SELECT 1 FROM attachments WHERE hichat_ascii_lower(file_url)=hichat_ascii_lower(?1))
 OR EXISTS(SELECT 1 FROM dm_attachments WHERE hichat_ascii_lower(file_url)=hichat_ascii_lower(?1))
 OR EXISTS(SELECT 1 FROM report_attachments WHERE hichat_ascii_lower(file_url)=hichat_ascii_lower(?1))
 OR EXISTS(SELECT 1 FROM feedback_attachments WHERE hichat_ascii_lower(file_url)=hichat_ascii_lower(?1))
 OR EXISTS(SELECT 1 FROM server_emojis WHERE hichat_ascii_lower(file_url)=hichat_ascii_lower(?1) OR hichat_ascii_lower(animated_url)=hichat_ascii_lower(?1))
 OR EXISTS(SELECT 1 FROM server_stickers WHERE hichat_ascii_lower(file_url)=hichat_ascii_lower(?1) OR hichat_ascii_lower(animated_url)=hichat_ascii_lower(?1))
 OR EXISTS(SELECT 1 FROM user_entrance_sounds WHERE hichat_ascii_lower(file_url)=hichat_ascii_lower(?1))
 OR EXISTS(SELECT 1 FROM soundboard_sounds WHERE hichat_ascii_lower(file_url)=hichat_ascii_lower(?1))
 OR EXISTS(SELECT 1 FROM badges WHERE hichat_ascii_lower(icon)=hichat_ascii_lower(?1))
 OR EXISTS(SELECT 1 FROM cosmetic_items WHERE hichat_ascii_lower(file_url)=hichat_ascii_lower(?1) OR hichat_ascii_lower(animated_url)=hichat_ascii_lower(?1))
 OR EXISTS(SELECT 1 FROM link_previews WHERE hichat_ascii_lower(image_url)=hichat_ascii_lower(?1) OR hichat_ascii_lower(favicon_url)=hichat_ascii_lower(?1))
 OR EXISTS(SELECT 1 FROM user_equipped WHERE instr(lower(asset_snapshot),lower(?1))>0)
 `
