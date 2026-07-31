package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

type sqliteRoleRepo struct {
	db database.TxQuerier
}

func NewSQLiteRoleRepo(db database.TxQuerier) RoleRepository {
	return &sqliteRoleRepo{db: db}
}

// scanRole scans one roles row in the column order shared by the role list
// queries (GetAllByServer, GetByUserIDAndServer).
func scanRole(rows *sql.Rows) (models.Role, error) {
	var role models.Role
	err := rows.Scan(
		&role.ID, &role.ServerID, &role.Name, &role.Color, &role.Position,
		&role.Permissions, &role.IsDefault, &role.IsOwner, &role.Mentionable, &role.CreatedAt,
	)
	return role, err
}

// ─── Read ───

func (r *sqliteRoleRepo) GetByID(ctx context.Context, id string) (*models.Role, error) {
	query := `
		SELECT id, server_id, name, color, position, permissions, is_default, is_owner, mentionable, created_at
		FROM roles WHERE id = ?`

	role := &models.Role{}
	err := r.db.QueryRowContext(ctx, query, id).Scan(
		&role.ID, &role.ServerID, &role.Name, &role.Color, &role.Position,
		&role.Permissions, &role.IsDefault, &role.IsOwner, &role.Mentionable, &role.CreatedAt,
	)

	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get role by id: %w", err)
	}

	return role, nil
}

func (r *sqliteRoleRepo) GetAllByServer(ctx context.Context, serverID string) ([]models.Role, error) {
	query := `
		SELECT id, server_id, name, color, position, permissions, is_default, is_owner, mentionable, created_at
		FROM roles WHERE server_id = ? ORDER BY position DESC`

	rows, err := r.db.QueryContext(ctx, query, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to get roles by server: %w", err)
	}
	return scanRows(rows, "role", scanRole)
}

func (r *sqliteRoleRepo) GetDefaultByServer(ctx context.Context, serverID string) (*models.Role, error) {
	query := `
		SELECT id, server_id, name, color, position, permissions, is_default, is_owner, mentionable, created_at
		FROM roles WHERE server_id = ? AND is_default = 1 LIMIT 1`

	role := &models.Role{}
	err := r.db.QueryRowContext(ctx, query, serverID).Scan(
		&role.ID, &role.ServerID, &role.Name, &role.Color, &role.Position,
		&role.Permissions, &role.IsDefault, &role.IsOwner, &role.Mentionable, &role.CreatedAt,
	)

	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get default role: %w", err)
	}

	return role, nil
}

func (r *sqliteRoleRepo) GetByUserIDAndServer(ctx context.Context, userID, serverID string) ([]models.Role, error) {
	query := `
		SELECT r.id, r.server_id, r.name, r.color, r.position, r.permissions, r.is_default, r.is_owner, r.mentionable, r.created_at
		FROM roles r
		INNER JOIN user_roles ur ON r.id = ur.role_id
		WHERE ur.user_id = ? AND ur.server_id = ?
		ORDER BY r.position DESC`

	rows, err := r.db.QueryContext(ctx, query, userID, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to get roles by user and server: %w", err)
	}
	return scanRows(rows, "role", scanRole)
}

// GetRolesForUsers batch-loads roles for multiple users in one server (avoids
// the per-user N+1 that broadcast fan-out used to run). Same join, filter and
// ordering as GetByUserIDAndServer, plus ur.user_id in the projection so the
// rows can be grouped. Users with no roles are absent from the map.
func (r *sqliteRoleRepo) GetRolesForUsers(ctx context.Context, serverID string, userIDs []string) (map[string][]models.Role, error) {
	if len(userIDs) == 0 {
		return map[string][]models.Role{}, nil
	}

	placeholders := strings.Repeat("?,", len(userIDs))
	placeholders = placeholders[:len(placeholders)-1]

	query := fmt.Sprintf(`
		SELECT ur.user_id, r.id, r.server_id, r.name, r.color, r.position, r.permissions, r.is_default, r.is_owner, r.mentionable, r.created_at
		FROM roles r
		INNER JOIN user_roles ur ON r.id = ur.role_id
		WHERE ur.server_id = ? AND ur.user_id IN (%s)
		ORDER BY r.position DESC`, placeholders)

	args := make([]any, 0, len(userIDs)+1)
	args = append(args, serverID)
	for _, id := range userIDs {
		args = append(args, id)
	}

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to get roles for users: %w", err)
	}
	defer rows.Close()

	out := make(map[string][]models.Role, len(userIDs))
	for rows.Next() {
		var userID string
		var role models.Role
		if err := rows.Scan(
			&userID, &role.ID, &role.ServerID, &role.Name, &role.Color, &role.Position,
			&role.Permissions, &role.IsDefault, &role.IsOwner, &role.Mentionable, &role.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("failed to scan role for users row: %w", err)
		}
		out[userID] = append(out[userID], role)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating roles for users rows: %w", err)
	}
	return out, nil
}

func (r *sqliteRoleRepo) GetMaxPosition(ctx context.Context, serverID string) (int, error) {
	var maxPos int
	err := r.db.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(position), 0) FROM roles WHERE server_id = ?`,
		serverID,
	).Scan(&maxPos)
	if err != nil {
		return 0, fmt.Errorf("failed to get max role position: %w", err)
	}
	return maxPos, nil
}

// ─── Write ───

func (r *sqliteRoleRepo) Create(ctx context.Context, role *models.Role) error {
	id, err := generateID()
	if err != nil {
		return fmt.Errorf("failed to create role: %w", err)
	}
	role.ID = id

	query := `
		INSERT INTO roles (id, server_id, name, color, position, permissions, is_default, is_owner, mentionable)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`

	isDefault := 0
	if role.IsDefault {
		isDefault = 1
	}
	isOwner := 0
	if role.IsOwner {
		isOwner = 1
	}
	mentionable := 0
	if role.Mentionable {
		mentionable = 1
	}

	if _, err := r.db.ExecContext(ctx, query,
		role.ID, role.ServerID, role.Name, role.Color, role.Position, role.Permissions, isDefault, isOwner, mentionable,
	); err != nil {
		return fmt.Errorf("failed to create role: %w", err)
	}

	// Best-effort read-back of the DB-side default created_at (RETURNING avoided
	// for Turso/Hrana safety — see sqlite_user.go Create).
	_ = r.db.QueryRowContext(ctx, "SELECT created_at FROM roles WHERE id = ?", role.ID).Scan(&role.CreatedAt)

	return nil
}

func (r *sqliteRoleRepo) Update(ctx context.Context, role *models.Role) error {
	query := `UPDATE roles SET name = ?, color = ?, permissions = ?, mentionable = ? WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query,
		role.Name, role.Color, role.Permissions, role.Mentionable, role.ID,
	)
	if err != nil {
		return fmt.Errorf("failed to update role: %w", err)
	}

	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to check rows affected: %w", err)
	}
	if affected == 0 {
		return pkg.ErrNotFound
	}

	return nil
}

func (r *sqliteRoleRepo) Delete(ctx context.Context, id string) error {
	// is_default = 0 guard: default role cannot be deleted
	query := `DELETE FROM roles WHERE id = ? AND is_default = 0`

	result, err := r.db.ExecContext(ctx, query, id)
	if err != nil {
		return fmt.Errorf("failed to delete role: %w", err)
	}

	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to check rows affected: %w", err)
	}
	if affected == 0 {
		return pkg.ErrNotFound
	}

	return nil
}

// UpdatePositions atomically updates role positions within a transaction.
func (r *sqliteRoleRepo) UpdatePositions(ctx context.Context, items []models.PositionUpdate) error {
	sqlDB := database.RawDB(r.db)
	if sqlDB == nil {
		return fmt.Errorf("UpdatePositions requires *sql.DB to start transaction")
	}
	tx, err := sqlDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer tx.Rollback()

	stmt, err := tx.PrepareContext(ctx, `UPDATE roles SET position = ? WHERE id = ?`)
	if err != nil {
		return fmt.Errorf("failed to prepare statement: %w", err)
	}
	defer func() { _ = stmt.Close() }() // transaction-scoped; commit/rollback above already decided the outcome

	for _, item := range items {
		result, err := stmt.ExecContext(ctx, item.Position, item.ID)
		if err != nil {
			return fmt.Errorf("failed to update position for role %s: %w", item.ID, err)
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return fmt.Errorf("failed to check rows affected for role %s: %w", item.ID, err)
		}
		if affected == 0 {
			return fmt.Errorf("%w: role %s", pkg.ErrNotFound, item.ID)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("failed to commit transaction: %w", err)
	}

	return nil
}

// ─── User-Role mapping ───

func (r *sqliteRoleRepo) AssignToUser(ctx context.Context, userID, roleID, serverID string) error {
	query := `INSERT OR IGNORE INTO user_roles (user_id, role_id, server_id) VALUES (?, ?, ?)`
	_, err := r.db.ExecContext(ctx, query, userID, roleID, serverID)
	if err != nil {
		return fmt.Errorf("failed to assign role to user: %w", err)
	}
	return nil
}

func (r *sqliteRoleRepo) RemoveFromUser(ctx context.Context, userID, roleID string) error {
	query := `DELETE FROM user_roles WHERE user_id = ? AND role_id = ?`
	_, err := r.db.ExecContext(ctx, query, userID, roleID)
	if err != nil {
		return fmt.Errorf("failed to remove role from user: %w", err)
	}
	return nil
}
