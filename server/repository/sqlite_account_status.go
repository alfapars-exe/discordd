package repository

import (
	"context"
	"database/sql"
	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

type AccountStatusRepository interface {
	Get(context.Context, string, int) (*models.AccountStatus, error)
}
type sqliteAccountStatusRepo struct{ db database.TxQuerier }

func NewSQLiteAccountStatusRepo(db database.TxQuerier) AccountStatusRepository {
	return &sqliteAccountStatusRepo{db: db}
}

func (r *sqliteAccountStatusRepo) Get(ctx context.Context, owner string, offset int) (*models.AccountStatus, error) {
	if offset < 0 || offset > 100000 {
		return nil, pkg.ErrBadRequest
	}
	// One statement supplies a consistent owner/platform/restriction snapshot.
	// Do not require current membership: a ban normally removes that membership.
	rows, err := r.db.QueryContext(ctx, `WITH active AS (
SELECT 'ban' kind,b.server_id,s.name server_name,b.reason,`+epochSecondsSQL(r.db, "b.created_at")+` created_at,`+epochSecondsSQL(r.db, "b.expires_at")+` expires_at
FROM bans b JOIN servers s ON s.id=b.server_id WHERE b.user_id=? AND (b.expires_at IS NULL OR b.expires_at>CURRENT_TIMESTAMP)
UNION ALL
SELECT 'timeout',m.server_id,s.name,m.reason,`+epochSecondsSQL(r.db, "m.created_at")+`,`+epochSecondsSQL(r.db, "m.expires_at")+`
FROM member_timeouts m JOIN servers s ON s.id=m.server_id WHERE m.user_id=? AND m.expires_at>CURRENT_TIMESTAMP
), page AS (SELECT * FROM active ORDER BY created_at DESC,kind,server_id LIMIT 51 OFFSET ?)
SELECT u.is_platform_banned,CASE WHEN u.is_platform_banned <> 0 THEN COALESCE(u.platform_ban_reason,'') ELSE '' END,`+epochSecondsSQL(r.db, "'now'")+`,p.kind,p.server_id,p.server_name,p.reason,p.created_at,p.expires_at
FROM users u LEFT JOIN page p ON 1=1 WHERE u.id=? ORDER BY p.created_at DESC,p.kind,p.server_id`, owner, owner, offset, owner)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := &models.AccountStatus{Restrictions: make([]models.AccountRestriction, 0)}
	found := false
	for rows.Next() {
		var kind, id, name, reason sql.NullString
		var created, expires sql.NullInt64
		if err := rows.Scan(&result.PlatformBanned, &result.PlatformReason, &result.CheckedAt, &kind, &id, &name, &reason, &created, &expires); err != nil {
			return nil, err
		}
		found = true
		if !kind.Valid {
			continue
		}
		if len(result.Restrictions) == 50 {
			next := offset + 50
			result.NextOffset = &next
			continue
		}
		item := models.AccountRestriction{Kind: kind.String, ServerID: id.String, ServerName: name.String, Reason: reason.String, CreatedAt: created.Int64}
		if expires.Valid {
			value := expires.Int64
			item.ExpiresAt = &value
		}
		result.Restrictions = append(result.Restrictions, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if !found {
		return nil, pkg.ErrNotFound
	}
	return result, nil
}
