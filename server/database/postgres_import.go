package database

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

type ImportTableReport struct {
	Table  string `json:"table"`
	Rows   int    `json:"rows"`
	SHA256 string `json:"sha256"`
}
type importColumn struct{ name, kind string }

// ImportSQLiteSnapshot only populates a newly created rehearsal schema. It
// compares every typed field, including IDs, password hashes and ciphertext,
// and commits only after all content hashes and deferred foreign keys pass.
// The caller must first migrate an offline COPY of the source to the current
// SQLite schema. No production schema is accepted by this function.
func ImportSQLiteSnapshot(ctx context.Context, source, target *sql.DB) ([]ImportTableReport, error) {
	var schema string
	if err := target.QueryRowContext(ctx, `SELECT current_schema()`).Scan(&schema); err != nil {
		return nil, err
	}
	if !regexp.MustCompile(`^hichat_import_[0-9]+$`).MatchString(schema) {
		return nil, fmt.Errorf("import requires a dedicated hichat_import_<timestamp> schema")
	}
	tx, err := target.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	snapshot, err := source.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer snapshot.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE' AND table_name<>'postgres_schema_migrations' ORDER BY table_name`)
	if err != nil {
		return nil, err
	}
	var tables []string
	for rows.Next() {
		var name string
		if err = rows.Scan(&name); err != nil {
			rows.Close()
			return nil, err
		}
		tables = append(tables, name)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	if len(tables) == 0 {
		return nil, fmt.Errorf("target schema has no tables")
	}
	known := make(map[string]bool, len(tables))
	seedTables := map[string]bool{"badges": true, "cosmetic_items": true, "data_export_archive_budget": true}
	for _, table := range tables {
		known[table] = true
	}
	for _, table := range []string{"sqlite_sequence", "messages_fts", "messages_fts_config", "messages_fts_data", "messages_fts_docsize", "messages_fts_idx", "dm_messages_fts", "dm_messages_fts_config", "dm_messages_fts_data", "dm_messages_fts_docsize", "dm_messages_fts_idx"} {
		known[table] = true
	}
	sourceTables, err := snapshot.QueryContext(ctx, `SELECT name FROM sqlite_master WHERE type='table'`)
	if err != nil {
		return nil, err
	}
	for sourceTables.Next() {
		var name string
		if err = sourceTables.Scan(&name); err != nil {
			sourceTables.Close()
			return nil, err
		}
		if !known[name] {
			sourceTables.Close()
			return nil, fmt.Errorf("unmapped source table %s; refusing incomplete import", name)
		}
	}
	err = sourceTables.Err()
	sourceTables.Close()
	if err != nil {
		return nil, err
	}
	// Refuse reusing a schema that already contains application state. The
	// baseline catalogs and the zeroed archive budget are the only seeded
	// tables allowed; the archive budget seed is validated below.
	for _, table := range tables {
		var count int
		if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM "+importQuote(table)).Scan(&count); err != nil {
			return nil, err
		}
		if table == "data_export_archive_budget" && count > 0 {
			if count != 1 {
				return nil, fmt.Errorf("target table %s is not empty", table)
			}
			var id int
			var reservedBytes int64
			if err = tx.QueryRowContext(ctx, `SELECT id,reserved_bytes FROM data_export_archive_budget`).Scan(&id, &reservedBytes); err != nil {
				return nil, err
			}
			if id != 1 || reservedBytes != 0 {
				return nil, fmt.Errorf("target table %s is not empty", table)
			}
		}
		if count != 0 && !seedTables[table] {
			return nil, fmt.Errorf("target table %s is not empty", table)
		}
	}
	if _, err = tx.ExecContext(ctx, `SET CONSTRAINTS ALL DEFERRED`); err != nil {
		return nil, err
	}
	for _, table := range tables {
		if _, err = tx.ExecContext(ctx, "ALTER TABLE "+importQuote(table)+" DISABLE TRIGGER USER"); err != nil {
			return nil, err
		}
	}
	for table := range seedTables {
		if known[table] {
			if _, err = tx.ExecContext(ctx, fmt.Sprintf("DELETE FROM %s", importQuote(table))); err != nil {
				return nil, err
			}
		}
	}
	var report []ImportTableReport
	for _, table := range tables {
		if table == "channel_send_operations" || table == "channel_delivery_outbox" || table == "channel_attachment_jobs" {
			continue
		}
		columns, err := importColumns(ctx, tx, table)
		if err != nil {
			return nil, err
		}
		// These fields are derived from legacy row order after content hashes
		// have been verified. They did not exist in SQLite snapshots.
		filtered := columns[:0]
		for _, col := range columns {
			if (table == "messages" && col.name == "source_sequence") || (table == "channels" && (col.name == "last_source_sequence" || col.name == "last_event_sequence")) || (table == "channel_reads" && col.name == "last_read_source_sequence") || (table == "attachments" && col.name == "channel_file_index") {
				continue
			}
			filtered = append(filtered, col)
		}
		columns = filtered
		if err = importCheckColumns(ctx, snapshot, table, columns); err != nil {
			return nil, err
		}
		names := make([]string, len(columns))
		sourceNames := make([]string, len(columns))
		binds := make([]string, len(columns))
		for i, col := range columns {
			names[i] = importQuote(col.name)
			sourceNames[i] = names[i]
			binds[i] = fmt.Sprintf("$%d", i+1)
			if (table == "channel_group_sessions" || table == "channel_sender_key_envelopes") && col.name == "insertion_order" {
				sourceNames[i] = "rowid"
			}
		}
		read, err := snapshot.QueryContext(ctx, fmt.Sprintf("SELECT %s FROM %s", strings.Join(sourceNames, ","), importQuote(table)))
		if err != nil {
			return nil, fmt.Errorf("source table %s does not match current migrations: %w", table, err)
		}
		insertPrefix := "INSERT INTO " + importQuote(table) + " (" + strings.Join(names, ",") + ") VALUES "
		batch := make([]any, 0, len(columns)*100)
		flush := func() error {
			if len(batch) == 0 {
				return nil
			}
			groups := make([]string, len(batch)/len(columns))
			for row := range groups {
				markers := make([]string, len(columns))
				for col := range markers {
					markers[col] = fmt.Sprintf("$%d", row*len(columns)+col+1)
				}
				groups[row] = "(" + strings.Join(markers, ",") + ")"
			}
			_, err := tx.ExecContext(ctx, insertPrefix+strings.Join(groups, ","), batch...)
			batch = batch[:0]
			return err
		}
		var hashes []string
		for read.Next() {
			values, err := importRead(read, columns)
			if err != nil {
				read.Close()
				return nil, fmt.Errorf("source table %s: %w", table, err)
			}
			batch = append(batch, values...)
			if len(batch) >= len(columns)*100 {
				err = flush()
			}
			if err != nil {
				read.Close()
				return nil, fmt.Errorf("insert into %s failed (row data withheld): %s", table, importErrorCode(err))
			}
			hashes = append(hashes, importRowHash(values))
		}
		err = read.Err()
		read.Close()
		if err != nil {
			return nil, err
		}
		if err = flush(); err != nil {
			return nil, fmt.Errorf("insert into %s failed (row data withheld): %s", table, importErrorCode(err))
		}
		actual, err := tx.QueryContext(ctx, fmt.Sprintf("SELECT %s FROM %s", strings.Join(names, ","), importQuote(table)))
		if err != nil {
			return nil, err
		}
		var actualHashes []string
		for actual.Next() {
			values, err := importRead(actual, columns)
			if err != nil {
				actual.Close()
				return nil, err
			}
			actualHashes = append(actualHashes, importRowHash(values))
		}
		err = actual.Err()
		actual.Close()
		if err != nil {
			return nil, err
		}
		expectedDigest := importSetHash(hashes)
		if len(hashes) != len(actualHashes) || expectedDigest != importSetHash(actualHashes) {
			return nil, fmt.Errorf("content verification failed for %s (expected_rows=%d actual_rows=%d expected_hash=%s actual_hash=%s)", table, len(hashes), len(actualHashes), expectedDigest, importSetHash(actualHashes))
		}
		report = append(report, ImportTableReport{table, len(hashes), expectedDigest})
	}
	if _, err = tx.ExecContext(ctx, `SELECT setval(pg_get_serial_sequence('channel_group_sessions','insertion_order'), COALESCE((SELECT MAX(insertion_order) FROM channel_group_sessions),1), EXISTS(SELECT FROM channel_group_sessions))`); err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `SELECT setval(pg_get_serial_sequence('channel_sender_key_envelopes','insertion_order'),COALESCE((SELECT MAX(insertion_order) FROM channel_sender_key_envelopes),1),EXISTS(SELECT FROM channel_sender_key_envelopes))`); err != nil {
		return nil, err
	}
	var metricSequence int64
	if err = snapshot.QueryRowContext(ctx, `SELECT COALESCE(MAX(seq),0) FROM sqlite_sequence WHERE name='livekit_metrics_history'`).Scan(&metricSequence); err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `SELECT setval(pg_get_serial_sequence('livekit_metrics_history','id'), GREATEST($1,COALESCE((SELECT MAX(id) FROM livekit_metrics_history),1)), $1>0 OR EXISTS(SELECT FROM livekit_metrics_history))`, metricSequence); err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `WITH ranked AS(SELECT id,row_number() OVER(PARTITION BY channel_id ORDER BY created_at,id) seq FROM messages) UPDATE messages SET source_sequence=ranked.seq FROM ranked WHERE ranked.id=messages.id;
 UPDATE channels SET last_source_sequence=COALESCE((SELECT MAX(source_sequence) FROM messages WHERE channel_id=channels.id),0);
 UPDATE channel_reads SET last_read_source_sequence=COALESCE((SELECT source_sequence FROM messages WHERE id=last_read_message_id AND channel_id=channel_reads.channel_id),0);`); err != nil {
		return nil, err
	}
	// Force foreign-key validation before re-enabling writes and committing.
	if _, err = tx.ExecContext(ctx, `SET CONSTRAINTS ALL IMMEDIATE`); err != nil {
		return nil, fmt.Errorf("relationship verification failed: %s", importErrorCode(err))
	}
	for _, table := range tables {
		if _, err = tx.ExecContext(ctx, "ALTER TABLE "+importQuote(table)+" ENABLE TRIGGER USER"); err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return report, nil
}

func importQuote(s string) string { return `"` + strings.ReplaceAll(s, `"`, `""`) + `"` }
func importCheckColumns(ctx context.Context, source *sql.Tx, table string, columns []importColumn) error {
	known := make(map[string]bool, len(columns))
	for _, c := range columns {
		known[c.name] = true
	}
	rows, err := source.QueryContext(ctx, "PRAGMA table_info("+importQuote(table)+")")
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var cid, notnull, pk int
		var name, kind string
		var defaultValue any
		if err = rows.Scan(&cid, &name, &kind, &notnull, &defaultValue, &pk); err != nil {
			return err
		}
		if !known[name] {
			return fmt.Errorf("unmapped source column %s.%s; refusing incomplete import", table, name)
		}
	}
	return rows.Err()
}
func importColumns(ctx context.Context, tx *sql.Tx, table string) ([]importColumn, error) {
	rows, err := tx.QueryContext(ctx, `SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 ORDER BY ordinal_position`, table)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []importColumn
	for rows.Next() {
		var c importColumn
		if err = rows.Scan(&c.name, &c.kind); err != nil {
			return nil, err
		}
		result = append(result, c)
	}
	return result, rows.Err()
}
func importRead(rows *sql.Rows, columns []importColumn) ([]any, error) {
	values := make([]any, len(columns))
	ptrs := make([]any, len(columns))
	for i := range values {
		ptrs[i] = &values[i]
	}
	if err := rows.Scan(ptrs...); err != nil {
		return nil, err
	}
	for i, c := range columns {
		v := values[i]
		if v == nil {
			continue
		}
		if b, ok := v.([]byte); ok {
			v = string(b)
		}
		switch c.kind {
		case "timestamp with time zone":
			if instant, ok := v.(time.Time); ok {
				values[i] = instant.UTC().Truncate(time.Microsecond)
				continue
			}
			text := fmt.Sprint(v)
			var instant time.Time
			var err error
			for _, layout := range []string{time.RFC3339Nano, "2006-01-02 15:04:05.999999999Z07:00", "2006-01-02 15:04:05.999999999-07", "2006-01-02 15:04:05.999999999", "2006-01-02"} {
				instant, err = time.Parse(layout, text)
				if err == nil {
					break
				}
			}
			if err != nil {
				return nil, fmt.Errorf("invalid timestamp in column %s (value withheld)", c.name)
			}
			// Match the microsecond precision used by pgx's timestamptz encoder.
			// Both the inserted value and its verification digest use this value.
			values[i] = instant.UTC().Truncate(time.Microsecond)
		case "bigint", "integer":
			if b, ok := v.(bool); ok {
				if b {
					v = int64(1)
				} else {
					v = int64(0)
				}
			}
			n, err := strconv.ParseInt(fmt.Sprint(v), 10, 64)
			if err != nil {
				return nil, fmt.Errorf("invalid integer in %s", c.name)
			}
			values[i] = n
		case "double precision", "real":
			n, err := strconv.ParseFloat(fmt.Sprint(v), 64)
			if err != nil || math.IsNaN(n) || math.IsInf(n, 0) {
				return nil, fmt.Errorf("invalid number in %s", c.name)
			}
			values[i] = n
		case "text":
			values[i] = fmt.Sprint(v)
		default:
			return nil, fmt.Errorf("unsupported type %s for %s", c.kind, c.name)
		}
	}
	return values, nil
}
func importRowHash(values []any) string {
	b, _ := json.Marshal(values)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
func importSetHash(hashes []string) string {
	sort.Strings(hashes)
	h := sha256.New()
	for _, v := range hashes {
		h.Write([]byte(v))
		h.Write([]byte{'\n'})
	}
	return hex.EncodeToString(h.Sum(nil))
}
func importErrorCode(err error) string {
	type state interface{ SQLState() string }
	if e, ok := err.(state); ok {
		return e.SQLState()
	}
	return "database error"
}
