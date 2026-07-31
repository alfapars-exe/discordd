package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

type sqliteCategoryRepo struct {
	db database.TxQuerier
}

func NewSQLiteCategoryRepo(db database.TxQuerier) CategoryRepository {
	return &sqliteCategoryRepo{db: db}
}

// scanCategory scans one categories row in the column order shared by the
// category list query.
func scanCategory(rows *sql.Rows) (models.Category, error) {
	var cat models.Category
	err := rows.Scan(&cat.ID, &cat.ServerID, &cat.Name, &cat.Position, &cat.CreatedAt)
	return cat, err
}

func (r *sqliteCategoryRepo) Create(ctx context.Context, category *models.Category) error {
	id, err := generateID()
	if err != nil {
		return fmt.Errorf("failed to create category: %w", err)
	}
	category.ID = id

	query := `
		INSERT INTO categories (id, server_id, name, position)
		VALUES (?, ?, ?, ?)`

	if _, err := r.db.ExecContext(ctx, query,
		category.ID,
		category.ServerID,
		category.Name,
		category.Position,
	); err != nil {
		return fmt.Errorf("failed to create category: %w", err)
	}

	// Best-effort read-back of the DB-side default created_at — RETURNING is
	// avoided so a dropped Turso/Hrana stream can't 500 the write (see
	// sqlite_user.go Create + database/retry.go).
	_ = r.db.QueryRowContext(ctx, "SELECT created_at FROM categories WHERE id = ?", category.ID).Scan(&category.CreatedAt)

	return nil
}

func (r *sqliteCategoryRepo) GetByID(ctx context.Context, id string) (*models.Category, error) {
	query := `SELECT id, server_id, name, position, created_at FROM categories WHERE id = ?`

	cat := &models.Category{}
	err := r.db.QueryRowContext(ctx, query, id).Scan(
		&cat.ID, &cat.ServerID, &cat.Name, &cat.Position, &cat.CreatedAt,
	)

	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get category by id: %w", err)
	}

	return cat, nil
}

func (r *sqliteCategoryRepo) GetAllByServer(ctx context.Context, serverID string) ([]models.Category, error) {
	query := `
		SELECT id, server_id, name, position, created_at
		FROM categories WHERE server_id = ? ORDER BY position ASC`

	rows, err := r.db.QueryContext(ctx, query, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to get categories by server: %w", err)
	}
	return scanRows(rows, "category", scanCategory)
}

func (r *sqliteCategoryRepo) Update(ctx context.Context, category *models.Category) error {
	query := `UPDATE categories SET name = ? WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query, category.Name, category.ID)
	if err != nil {
		return fmt.Errorf("failed to update category: %w", err)
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

func (r *sqliteCategoryRepo) Delete(ctx context.Context, id string) error {
	// ON DELETE SET NULL nullifies channel category_id references.
	result, err := r.db.ExecContext(ctx, `DELETE FROM categories WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("failed to delete category: %w", err)
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

// UpdatePositions atomically updates positions for multiple categories.
func (r *sqliteCategoryRepo) UpdatePositions(ctx context.Context, items []models.PositionUpdate) error {
	sqlDB := database.RawDB(r.db)
	if sqlDB == nil {
		return fmt.Errorf("UpdatePositions requires *sql.DB to start transaction")
	}
	tx, err := sqlDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }() // no-op once Commit succeeds (ErrTxDone), expected on the happy path

	stmt, err := tx.PrepareContext(ctx, `UPDATE categories SET position = ? WHERE id = ?`)
	if err != nil {
		return fmt.Errorf("failed to prepare statement: %w", err)
	}
	defer func() { _ = stmt.Close() }() // transaction-scoped; commit/rollback above already decided the outcome

	for _, item := range items {
		result, err := stmt.ExecContext(ctx, item.Position, item.ID)
		if err != nil {
			return fmt.Errorf("failed to update position for category %s: %w", item.ID, err)
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return fmt.Errorf("failed to check rows affected for category %s: %w", item.ID, err)
		}
		if affected == 0 {
			return fmt.Errorf("%w: category %s", pkg.ErrNotFound, item.ID)
		}
	}

	return tx.Commit()
}

func (r *sqliteCategoryRepo) GetMaxPosition(ctx context.Context, serverID string) (int, error) {
	var maxPos int
	err := r.db.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(position), -1) FROM categories WHERE server_id = ?`,
		serverID,
	).Scan(&maxPos)
	if err != nil {
		return 0, fmt.Errorf("failed to get max category position: %w", err)
	}
	return maxPos, nil
}
