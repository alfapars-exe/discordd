package repository

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

type sqliteAppLogRepo struct {
	db database.TxQuerier
}

func NewSQLiteAppLogRepo(db database.TxQuerier) AppLogRepository {
	return &sqliteAppLogRepo{db: db}
}

func (r *sqliteAppLogRepo) Insert(ctx context.Context, entry *models.AppLog) error {
	_, err := r.InsertBatch(ctx, []models.AppLog{*entry})
	return err
}

// InsertBatch filters deleted owners inside the statement. The deleted-user
// triggers remain the final guard; one excluded owner cannot reject the batch.
func (r *sqliteAppLogRepo) InsertBatch(ctx context.Context, entries []models.AppLog) (int64, error) {
	if len(entries) == 0 {
		return 0, nil
	}
	if len(entries) > 64 {
		return 0, fmt.Errorf("app log batch exceeds 64 rows")
	}
	stamp := "?"
	if database.IsPostgres(r.db) {
		stamp = "CAST(? AS TIMESTAMPTZ)"
	}
	values := make([]string, 0, len(entries))
	args := make([]any, 0, len(entries)*13)
	for _, e := range entries {
		if e.CreatedAt == "" {
			e.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
		}
		if e.LastSeenAt == "" {
			e.LastSeenAt = e.CreatedAt
		}
		e.CreatedAt = appLogDBTime(r.db, e.CreatedAt)
		e.LastSeenAt = appLogDBTime(r.db, e.LastSeenAt)
		if e.OccurrenceCount < 1 {
			e.OccurrenceCount = 1
		}
		values = append(values, "(?,?,?,?,?,?,"+stamp+",?,?,?,?,CAST(? AS BIGINT),"+stamp+")")
		args = append(args, e.Level, e.Category, e.UserID, e.ServerID, e.Message, e.Metadata, e.CreatedAt, e.RequestID, e.EventCode, e.Component, e.ErrorKind, e.OccurrenceCount, e.LastSeenAt)
	}
	query := `WITH incoming(level,category,user_id,server_id,message,metadata,created_at,request_id,event_code,component,error_kind,occurrence_count,last_seen_at) AS (VALUES ` + strings.Join(values, ",") + `)
 INSERT INTO app_logs(level,category,user_id,server_id,message,metadata,created_at,request_id,event_code,component,error_kind,occurrence_count,last_seen_at)
 SELECT i.* FROM incoming i WHERE NOT EXISTS(SELECT 1 FROM users u WHERE u.id=i.user_id AND u.deleted_at IS NOT NULL)`
	res, err := r.db.ExecContext(ctx, query, args...)
	if err != nil {
		return 0, fmt.Errorf("insert app log batch: %w", err)
	}
	return res.RowsAffected()
}

func (r *sqliteAppLogRepo) List(ctx context.Context, filter models.AppLogFilter) ([]models.AppLog, int, error) {
	var conditions []string
	var args []interface{}
	for _, f := range []struct{ column, value string }{{"a.request_id", filter.RequestID}, {"a.event_code", filter.EventCode}, {"a.component", filter.Component}} {
		if f.value != "" {
			conditions = append(conditions, f.column+" = ?")
			args = append(args, f.value)
		}
	}
	if filter.From != "" {
		conditions = append(conditions, "a.created_at >= ?")
		args = append(args, appLogDBTime(r.db, filter.From))
	}
	if filter.To != "" {
		conditions = append(conditions, "a.created_at <= ?")
		args = append(args, appLogDBTime(r.db, filter.To))
	}

	if filter.Level != "" {
		conditions = append(conditions, "a.level = ?")
		args = append(args, filter.Level)
	}
	if filter.Category != "" {
		conditions = append(conditions, "a.category = ?")
		args = append(args, filter.Category)
	}
	if filter.Search != "" {
		conditions = append(conditions, "(a.message LIKE ? OR u.username LIKE ? OR u.display_name LIKE ? OR a.request_id LIKE ? OR a.event_code LIKE ? OR a.component LIKE ?)")
		args = append(args, "%"+filter.Search+"%", "%"+filter.Search+"%", "%"+filter.Search+"%", "%"+filter.Search+"%", "%"+filter.Search+"%", "%"+filter.Search+"%")
	}

	where := ""
	if len(conditions) > 0 {
		where = " WHERE " + strings.Join(conditions, " AND ")
	}

	// Count total (JOIN needed for username/display_name search)
	countQuery := "SELECT COUNT(*) FROM app_logs a LEFT JOIN users u ON a.user_id = u.id" + where
	var total int
	if err := r.db.QueryRowContext(ctx, countQuery, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count app logs: %w", err)
	}

	// Fetch page with username resolution via LEFT JOIN
	limit := filter.Limit
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	offset := filter.Offset
	if offset < 0 {
		offset = 0
	}

	query := `SELECT a.id, a.level, a.category, a.user_id, a.server_id, a.message, a.metadata, a.created_at,
		u.username, u.display_name, a.request_id, a.event_code, a.component, a.error_kind, a.occurrence_count, COALESCE(a.last_seen_at,a.created_at)
		FROM app_logs a LEFT JOIN users u ON a.user_id = u.id` +
		where + " ORDER BY a.created_at DESC,a.id DESC LIMIT ? OFFSET ?"

	// Fresh slice — appending to args and assigning elsewhere risks aliasing
	// args' backing array (gocritic appendAssign).
	pageArgs := make([]interface{}, 0, len(args)+2)
	pageArgs = append(pageArgs, args...)
	pageArgs = append(pageArgs, limit, offset)
	rows, err := r.db.QueryContext(ctx, query, pageArgs...)
	if err != nil {
		return nil, 0, fmt.Errorf("list app logs: %w", err)
	}
	defer rows.Close()

	var logs []models.AppLog
	for rows.Next() {
		var l models.AppLog
		if err := rows.Scan(&l.ID, &l.Level, &l.Category, &l.UserID, &l.ServerID, &l.Message, &l.Metadata, &l.CreatedAt,
			&l.Username, &l.DisplayName, &l.RequestID, &l.EventCode, &l.Component, &l.ErrorKind, &l.OccurrenceCount, &l.LastSeenAt); err != nil {
			return nil, 0, fmt.Errorf("scan app log: %w", err)
		}
		logs = append(logs, l)
	}

	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("iterate app logs: %w", err)
	}
	return logs, total, nil
}

func (r *sqliteAppLogRepo) DeleteBefore(ctx context.Context, before string) (int64, error) {
	res, err := r.db.ExecContext(ctx, "DELETE FROM app_logs WHERE id IN (SELECT id FROM app_logs WHERE created_at < ? ORDER BY created_at LIMIT 1000)", before)
	if err != nil {
		return 0, fmt.Errorf("delete old app logs: %w", err)
	}
	return res.RowsAffected()
}

func (r *sqliteAppLogRepo) DeleteAll(ctx context.Context) error {
	_, err := r.db.ExecContext(ctx, "DELETE FROM app_logs")
	if err != nil {
		return fmt.Errorf("clear app logs: %w", err)
	}
	return nil
}

func appLogDBTime(db database.TxQuerier, value string) string {
	if database.IsPostgres(db) {
		return value
	}
	if t, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return t.UTC().Format("2006-01-02 15:04:05.000000000")
	}
	return value
}
