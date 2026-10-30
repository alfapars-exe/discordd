package repository

import (
	"context"
	"database/sql"
	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

type AccountDeletionStatusRepository interface {
	Get(context.Context, string, int) (*models.AccountDeletionStatus, error)
}
type sqliteAccountDeletionStatusRepo struct{ db database.TxQuerier }

func NewSQLiteAccountDeletionStatusRepo(db database.TxQuerier) AccountDeletionStatusRepository {
	return &sqliteAccountDeletionStatusRepo{db: db}
}
func (r *sqliteAccountDeletionStatusRepo) Get(ctx context.Context, owner string, offset int) (*models.AccountDeletionStatus, error) {
	if offset < 0 || offset > 100000 {
		return nil, pkg.ErrBadRequest
	}
	rows, err := r.db.QueryContext(ctx, `WITH owned AS (
	 SELECT 'server' kind,id,name FROM servers WHERE owner_id=?1
	 UNION ALL SELECT 'application',id,COALESCE(NULLIF(display_name,''),username) FROM users WHERE owner_user_id=?1
	), page AS (SELECT * FROM owned ORDER BY kind,id LIMIT 51 OFFSET ?2)
	SELECT u.is_platform_admin,(SELECT COUNT(*) FROM owned),`+epochSecondsSQL(r.db, "'now'")+`,p.kind,p.id,p.name
	FROM users u LEFT JOIN page p ON 1=1 WHERE u.id=?1 AND u.deleted_at IS NULL ORDER BY p.kind,p.id`, owner, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := &models.AccountDeletionStatus{Resources: []models.AccountOwnedResource{}}
	found := false
	for rows.Next() {
		var kind, id, name sql.NullString
		if err := rows.Scan(&result.PlatformAdmin, &result.OwnedCount, &result.CheckedAt, &kind, &id, &name); err != nil {
			return nil, err
		}
		found = true
		if kind.Valid {
			if len(result.Resources) == 50 {
				next := offset + 50
				result.NextOffset = &next
				continue
			}
			result.Resources = append(result.Resources, models.AccountOwnedResource{Kind: kind.String, ID: id.String, Name: name.String})
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if !found {
		return nil, pkg.ErrNotFound
	}
	return result, nil
}
