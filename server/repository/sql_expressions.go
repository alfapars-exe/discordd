package repository

import "github.com/argeinfina/hichat/database"

// Dialect-specific expressions are chosen where a repository constructs its
// query. The PostgreSQL driver only binds parameters; it never rewrites SQL.
// column is always a hard-coded SQL identifier, never request input.
func epochSecondsSQL(db database.TxQuerier, column string) string {
	if database.IsPostgres(db) {
		if column == "'now'" {
			column = "CURRENT_TIMESTAMP"
		}
		return "CAST(EXTRACT(EPOCH FROM " + column + ") AS BIGINT)"
	}
	return "CAST(strftime('%s'," + column + ") AS INTEGER)"
}
func reactionUsersSQL(db database.TxQuerier) string {
	if database.IsPostgres(db) {
		return "string_agg(user_id, ',')"
	}
	return "GROUP_CONCAT(user_id)"
}
func snapshotObjectSQL(db database.TxQuerier) string {
	if database.IsPostgres(db) {
		return "hichat_json_object"
	}
	return "json_object"
}
