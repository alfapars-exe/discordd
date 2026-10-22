package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

type sqliteCosmeticRepo struct {
	db database.TxQuerier
}

func NewSQLiteCosmeticRepo(db database.TxQuerier) CosmeticRepository {
	return &sqliteCosmeticRepo{db: db}
}

// cosmeticNowText is the 'YYYY-MM-DD HH:MM:SS' UTC text every timestamp
// column of migration 089 stores (trap #130: never bind a time.Time).
func cosmeticNowText() string {
	return time.Now().UTC().Format("2006-01-02 15:04:05")
}

// scanCosmeticItem reads the column order every cosmetic_items SELECT below
// spells out inline: id, server_id, type, format, name, description,
// asset_json, file_url, animated_url, animated, availability, created_by,
// sort_order, created_at (trap #96: Scan is positional).
func scanCosmeticItem(rs rowScanner) (models.CosmeticItem, error) {
	var (
		it          models.CosmeticItem
		serverID    sql.NullString
		description sql.NullString
		assetJSON   sql.NullString
		fileURL     sql.NullString
		animatedURL sql.NullString
		animated    int
		createdBy   sql.NullString
		createdAt   string
	)
	if err := rs.Scan(&it.ID, &serverID, &it.Type, &it.Format, &it.Name, &description,
		&assetJSON, &fileURL, &animatedURL, &animated, &it.Availability, &createdBy,
		&it.SortOrder, &createdAt); err != nil {
		return models.CosmeticItem{}, err
	}
	it.ServerID = nullStringPtr(serverID)
	it.Description = nullStringPtr(description)
	it.AssetJSON = nullStringPtr(assetJSON)
	it.FileURL = nullStringPtr(fileURL)
	it.AnimatedURL = nullStringPtr(animatedURL)
	it.CreatedBy = nullStringPtr(createdBy)
	it.Animated = animated != 0
	it.CreatedAt = dbTextToRFC3339(createdAt)
	return it, nil
}

// scanCosmeticEquipped reads the column order every user_equipped SELECT
// below spells out inline: ue.user_id, ue.scope_server_id, ue.type,
// ue.item_id, ue.format, ue.animated, ue.asset_snapshot, ue.equipped_at,
// ci.server_id (always joined to cosmetic_items, so a row whose item is
// gone is never returned).
func scanCosmeticEquipped(rs rowScanner) (models.CosmeticEquippedRow, error) {
	var (
		row          models.CosmeticEquippedRow
		animated     int
		equippedAt   string
		itemServerID sql.NullString
	)
	if err := rs.Scan(&row.UserID, &row.ScopeServerID, &row.Type, &row.ItemID, &row.Format,
		&animated, &row.AssetSnapshot, &equippedAt, &itemServerID); err != nil {
		return models.CosmeticEquippedRow{}, err
	}
	row.Animated = animated != 0
	row.EquippedAt = dbTextToRFC3339(equippedAt)
	row.ItemServerID = nullStringPtr(itemServerID)
	return row, nil
}

func (r *sqliteCosmeticRepo) queryItems(ctx context.Context, query string, args ...any) ([]models.CosmeticItem, error) {
	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to list cosmetic items: %w", err)
	}
	defer rows.Close()
	out := []models.CosmeticItem{}
	for rows.Next() {
		it, err := scanCosmeticItem(rows)
		if err != nil {
			return nil, fmt.Errorf("failed to scan cosmetic item: %w", err)
		}
		out = append(out, it)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to iterate cosmetic items: %w", err)
	}
	return out, nil
}

func (r *sqliteCosmeticRepo) queryEquipped(ctx context.Context, query string, args ...any) ([]models.CosmeticEquippedRow, error) {
	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to list equipped cosmetics: %w", err)
	}
	defer rows.Close()
	out := []models.CosmeticEquippedRow{}
	for rows.Next() {
		row, err := scanCosmeticEquipped(rows)
		if err != nil {
			return nil, fmt.Errorf("failed to scan equipped cosmetic: %w", err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to iterate equipped cosmetics: %w", err)
	}
	return out, nil
}

func (r *sqliteCosmeticRepo) ListBuiltinItems(ctx context.Context) ([]models.CosmeticItem, error) {
	return r.queryItems(ctx,
		`SELECT id, server_id, type, format, name, description, asset_json, file_url, animated_url,
		        animated, availability, created_by, sort_order, created_at
		 FROM cosmetic_items WHERE server_id IS NULL
		 ORDER BY CASE type WHEN 'avatar_frame' THEN 0 WHEN 'nameplate' THEN 1 WHEN 'name_style' THEN 2
		          WHEN 'profile_theme' THEN 3 ELSE 4 END, sort_order, id`)
}

func (r *sqliteCosmeticRepo) ListEquippableServerItems(ctx context.Context, userID string) ([]models.CosmeticItem, error) {
	return r.queryItems(ctx,
		`SELECT ci.id, ci.server_id, ci.type, ci.format, ci.name, ci.description, ci.asset_json, ci.file_url,
		        ci.animated_url, ci.animated, ci.availability, ci.created_by, ci.sort_order, ci.created_at
		 FROM cosmetic_items ci
		 WHERE ci.server_id IS NOT NULL
		   AND EXISTS (SELECT 1 FROM server_members sm WHERE sm.server_id = ci.server_id AND sm.user_id = ?)
		   AND (ci.availability = 'free'
		        OR EXISTS (SELECT 1 FROM user_cosmetics uc WHERE uc.item_id = ci.id AND uc.user_id = ?))
		 ORDER BY ci.server_id, ci.sort_order, ci.created_at, ci.id`, userID, userID)
}

func (r *sqliteCosmeticRepo) GetItem(ctx context.Context, id string) (*models.CosmeticItem, error) {
	row := r.db.QueryRowContext(ctx,
		`SELECT id, server_id, type, format, name, description, asset_json, file_url, animated_url,
		        animated, availability, created_by, sort_order, created_at
		 FROM cosmetic_items WHERE id = ?`, id)
	it, err := scanCosmeticItem(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, models.ErrCosmeticItemNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get cosmetic item: %w", err)
	}
	return &it, nil
}

func (r *sqliteCosmeticRepo) HasGrant(ctx context.Context, userID, itemID string) (bool, error) {
	return r.exists(ctx, "cosmetic grant",
		`SELECT EXISTS(SELECT 1 FROM user_cosmetics WHERE user_id = ? AND item_id = ?)`, userID, itemID)
}

func (r *sqliteCosmeticRepo) ListGrants(ctx context.Context, userID string) ([]models.CosmeticGrant, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT uc.item_id, uc.server_id, uc.reason, uc.granted_at, u.id, u.username, u.display_name
		 FROM user_cosmetics uc
		 LEFT JOIN users u ON u.id = uc.granted_by
		 WHERE uc.user_id = ?
		 ORDER BY uc.granted_at, uc.item_id`, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to list cosmetic grants: %w", err)
	}
	defer rows.Close()
	out := []models.CosmeticGrant{}
	for rows.Next() {
		var (
			g          models.CosmeticGrant
			grantedAt  string
			byID       sql.NullString
			byUsername sql.NullString
			byDisplay  sql.NullString
		)
		if err := rows.Scan(&g.ItemID, &g.ServerID, &g.Reason, &grantedAt, &byID, &byUsername, &byDisplay); err != nil {
			return nil, fmt.Errorf("failed to scan cosmetic grant: %w", err)
		}
		g.GrantedAt = dbTextToRFC3339(grantedAt)
		if byID.Valid {
			g.GrantedBy = &models.CosmeticGrantUser{ID: byID.String, Username: byUsername.String, DisplayName: nullStringPtr(byDisplay)}
		}
		out = append(out, g)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to iterate cosmetic grants: %w", err)
	}
	return out, nil
}

func (r *sqliteCosmeticRepo) ListEquipped(ctx context.Context, userID string) ([]models.CosmeticEquippedRow, error) {
	return r.queryEquipped(ctx,
		`SELECT ue.user_id, ue.scope_server_id, ue.type, ue.item_id, ue.format, ue.animated,
		        ue.asset_snapshot, ue.equipped_at, ci.server_id
		 FROM user_equipped ue
		 JOIN cosmetic_items ci ON ci.id = ue.item_id
		 WHERE ue.user_id = ?
		 ORDER BY ue.scope_server_id, ue.type`, userID)
}

func (r *sqliteCosmeticRepo) ApplyEquip(ctx context.Context, userID, scopeServerID string, set map[string]models.CosmeticEquipRow, unset []string) (bool, error) {
	var changed bool
	run := func(q database.TxQuerier) error {
		var err error
		changed, err = applyEquipStmts(ctx, q, userID, scopeServerID, set, unset)
		return err
	}
	sqlDB := database.RawDB(r.db)
	if sqlDB == nil {
		// r.db is already a transaction - let the caller's tx provide the
		// atomicity (same pattern as HardDeleteUser).
		if err := run(r.db); err != nil {
			return false, err
		}
		return changed, nil
	}
	if err := database.WithTx(ctx, sqlDB, func(tx *sql.Tx) error { return run(tx) }); err != nil {
		return false, err
	}
	return changed, nil
}

// applyEquipStmts reads the scope's current rows, then upserts every set
// entry that differs and deletes every unset type that exists.
func applyEquipStmts(ctx context.Context, q database.TxQuerier, userID, scopeServerID string, set map[string]models.CosmeticEquipRow, unset []string) (bool, error) {
	rows, err := q.QueryContext(ctx,
		`SELECT type, item_id, format, animated, asset_snapshot
		 FROM user_equipped WHERE user_id = ? AND scope_server_id = ?`, userID, scopeServerID)
	if err != nil {
		return false, fmt.Errorf("failed to read equipped cosmetics: %w", err)
	}
	current := map[string]models.CosmeticEquipRow{}
	for rows.Next() {
		var (
			typ      string
			row      models.CosmeticEquipRow
			animated int
		)
		if err := rows.Scan(&typ, &row.ItemID, &row.Format, &animated, &row.AssetSnapshot); err != nil {
			_ = rows.Close()
			return false, fmt.Errorf("failed to scan equipped cosmetic: %w", err)
		}
		row.Animated = animated != 0
		current[typ] = row
	}
	iterErr := rows.Err()
	_ = rows.Close()
	if iterErr != nil {
		return false, fmt.Errorf("failed to iterate equipped cosmetics: %w", iterErr)
	}

	changed := false
	now := cosmeticNowText()
	for typ, want := range set {
		if have, ok := current[typ]; ok && have == want {
			continue
		}
		if _, err := q.ExecContext(ctx,
			`INSERT INTO user_equipped (user_id, scope_server_id, type, item_id, format, animated, asset_snapshot, equipped_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(user_id, scope_server_id, type) DO UPDATE SET
			   item_id = excluded.item_id, format = excluded.format, animated = excluded.animated,
			   asset_snapshot = excluded.asset_snapshot, equipped_at = excluded.equipped_at`,
			userID, scopeServerID, typ, want.ItemID, want.Format, boolInt(want.Animated), want.AssetSnapshot, now); err != nil {
			return false, fmt.Errorf("failed to equip cosmetic: %w", err)
		}
		changed = true
	}
	for _, typ := range unset {
		if _, ok := current[typ]; !ok {
			continue
		}
		if _, err := q.ExecContext(ctx,
			`DELETE FROM user_equipped WHERE user_id = ? AND scope_server_id = ? AND type = ?`,
			userID, scopeServerID, typ); err != nil {
			return false, fmt.Errorf("failed to unequip cosmetic: %w", err)
		}
		changed = true
	}
	return changed, nil
}

func (r *sqliteCosmeticRepo) ListPlainServers(ctx context.Context, userID string) ([]string, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT server_id FROM user_cosmetic_plain_servers WHERE user_id = ? ORDER BY server_id`, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to list plain servers: %w", err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("failed to scan plain server: %w", err)
		}
		out = append(out, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to iterate plain servers: %w", err)
	}
	return out, nil
}

func (r *sqliteCosmeticRepo) SetPlainServer(ctx context.Context, userID, serverID string, plain bool) (bool, error) {
	var (
		res sql.Result
		err error
	)
	if plain {
		res, err = r.db.ExecContext(ctx,
			`INSERT INTO user_cosmetic_plain_servers (user_id, server_id, created_at) VALUES (?, ?, ?)
			 ON CONFLICT(user_id, server_id) DO NOTHING`, userID, serverID, cosmeticNowText())
	} else {
		res, err = r.db.ExecContext(ctx,
			`DELETE FROM user_cosmetic_plain_servers WHERE user_id = ? AND server_id = ?`, userID, serverID)
	}
	if err != nil {
		return false, fmt.Errorf("failed to set plain server: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("failed to check rows affected: %w", err)
	}
	return n > 0, nil
}

func (r *sqliteCosmeticRepo) IsPlain(ctx context.Context, userID, serverID string) (bool, error) {
	return r.exists(ctx, "plain server",
		`SELECT EXISTS(SELECT 1 FROM user_cosmetic_plain_servers WHERE user_id = ? AND server_id = ?)`, userID, serverID)
}

func (r *sqliteCosmeticRepo) GlobalSlotsForUsers(ctx context.Context, ids []string) (map[string]models.CosmeticSlots, error) {
	out := map[string]models.CosmeticSlots{}
	if len(ids) == 0 {
		return out, nil
	}
	if len(ids) > models.CosmeticLookupMaxIDs {
		return nil, models.ErrCosmeticIDsInvalid
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	rows, err := r.queryEquipped(ctx,
		`SELECT ue.user_id, ue.scope_server_id, ue.type, ue.item_id, ue.format, ue.animated,
		        ue.asset_snapshot, ue.equipped_at, ci.server_id
		 FROM user_equipped ue
		 JOIN cosmetic_items ci ON ci.id = ue.item_id
		 WHERE ue.scope_server_id = '' AND ci.server_id IS NULL
		   AND ue.user_id IN (`+placeholders+`)
		 ORDER BY ue.user_id, ue.type`, args...)
	if err != nil {
		return nil, err
	}
	return resolveByUser(rows, ""), nil
}

func (r *sqliteCosmeticRepo) ServerSlots(ctx context.Context, serverID string) (map[string]models.CosmeticSlots, error) {
	rows, err := r.queryEquipped(ctx,
		`SELECT ue.user_id, ue.scope_server_id, ue.type, ue.item_id, ue.format, ue.animated,
		        ue.asset_snapshot, ue.equipped_at, ci.server_id
		 FROM user_equipped ue
		 JOIN server_members sm ON sm.user_id = ue.user_id AND sm.server_id = ?
		 JOIN cosmetic_items ci ON ci.id = ue.item_id
		 WHERE ue.scope_server_id IN ('', ?)
		   AND (ci.server_id IS NULL OR ci.server_id = ?)
		   AND NOT EXISTS (SELECT 1 FROM user_cosmetic_plain_servers p
		                   WHERE p.user_id = ue.user_id AND p.server_id = ?)
		 ORDER BY ue.user_id, ue.scope_server_id, ue.type`, serverID, serverID, serverID, serverID)
	if err != nil {
		return nil, err
	}
	return resolveByUser(rows, serverID), nil
}

func (r *sqliteCosmeticRepo) SlotsForUserInServer(ctx context.Context, userID, serverID string) (models.CosmeticSlots, bool, error) {
	plain, err := r.IsPlain(ctx, userID, serverID)
	if err != nil {
		return nil, false, err
	}
	if plain {
		return models.CosmeticSlots{}, true, nil
	}
	rows, err := r.queryEquipped(ctx,
		`SELECT ue.user_id, ue.scope_server_id, ue.type, ue.item_id, ue.format, ue.animated,
		        ue.asset_snapshot, ue.equipped_at, ci.server_id
		 FROM user_equipped ue
		 JOIN cosmetic_items ci ON ci.id = ue.item_id
		 WHERE ue.user_id = ? AND ue.scope_server_id IN ('', ?)
		   AND (ci.server_id IS NULL OR ci.server_id = ?)
		 ORDER BY ue.scope_server_id, ue.type`, userID, serverID, serverID)
	if err != nil {
		return nil, false, err
	}
	return models.ResolveCosmeticSlots(rows, serverID), false, nil
}

// resolveByUser groups rows by user and resolves each user's slots for
// serverID (” = global), leaving out users whose resolved slots are empty.
func resolveByUser(rows []models.CosmeticEquippedRow, serverID string) map[string]models.CosmeticSlots {
	byUser := map[string][]models.CosmeticEquippedRow{}
	for _, row := range rows {
		byUser[row.UserID] = append(byUser[row.UserID], row)
	}
	out := make(map[string]models.CosmeticSlots, len(byUser))
	for userID, userRows := range byUser {
		if slots := models.ResolveCosmeticSlots(userRows, serverID); len(slots) > 0 {
			out[userID] = slots
		}
	}
	return out
}

func (r *sqliteCosmeticRepo) exists(ctx context.Context, what, query string, args ...any) (bool, error) {
	var n int
	if err := r.db.QueryRowContext(ctx, query, args...).Scan(&n); err != nil {
		return false, fmt.Errorf("failed to check %s: %w", what, err)
	}
	return n != 0, nil
}
