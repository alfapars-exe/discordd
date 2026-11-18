package database

import (
	"crypto/sha256"
	"fmt"
	"io/fs"
	"strings"
)

type legacyBaseline struct{ lastFile, migrationDigest string }

// Generated from clean SQLite databases upgraded through the indicated file.
// Never extend this list using a schema obtained from an unverified import.
var legacyBaselines = map[string]legacyBaseline{
	"d3f5824882e566b7e456159ec4cb4e8f7d5813a22c06e2ab9efb0c37baccdf97": {"144_thread_channel_type.sql", "7226307a63e056e005269533cee5ca2969996e195e0d353495df37224cdbb262"},
	"a12373f1a25077a5a9f346e439515b2772da1813b6e5fff5c37fde7ab33f5ef0": {"145_channel_message_notification_jobs.sql", "ac063317f1eafc6eb1c7cabd4316edc1d8fcb578a68a585b4a393c876934daeb"},
	"b324bd7056cf458a5673547b7e19e81d693906943f900a19aece7ae0790ca2b8": {"146_data_export_archives.sql", "487676c6dcd3860f6c780a975da4c38b3f8056b9c6b67c585ba3b3d9003385b2"},
	"b6669d744dd12ee820c20c67733d36da0bf51271593ab1d02e4b836aab261e2c": {"147_email_provider_idempotency.sql", "62659ca0a7e6cca2d05ef6dd502bacd4dcd05f349d4e314bc7d11e77595db623"},
	"3fcb3d7aefae5911f55392d9a2211de278ab7d372381617099efaacb12de12cc": {"148_dm_send_receipts.sql", "ece748b03dedebe2de7cb53446e2dd6fc8e3903c9e411b166fdc059de0301bdd"},
	"9065e9ed38000d37c8b188b9b3da9267828b651f507feca8c85be836e4aec48a": {"149_dm_event_sequence.sql", "eb7bdf352730137534de25ccb119df02fc11f1df7300b4968fac1eb99966a704"},
	"21b6440ca3eec36f90aeac8226534e8f0152876a43870e757c5b67d833d453a9": {"150_dm_attachment_order.sql", "8d36e093ef8749242b77b513f57d720c8ae87997cabe2507f7ca3e05ab1e65f8"},
}

func (db *DB) adoptLegacySchema(migrations fs.FS, files []string, applied map[string]bool) error {
	tx, err := db.Conn.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.Query(`SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND name<>'schema_migrations' ORDER BY type,name`)
	if err != nil {
		return err
	}
	defer rows.Close()
	schema := sha256.New()
	count := 0
	for rows.Next() {
		var kind, name, ddl string
		if err := rows.Scan(&kind, &name, &ddl); err != nil {
			return err
		}
		fmt.Fprintf(schema, "%s\x00%s\x00%s\x00", kind, name, strings.ReplaceAll(ddl, "\r\n", "\n"))
		count++
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if count == 0 {
		return nil
	}
	fingerprint := fmt.Sprintf("%x", schema.Sum(nil))
	baseline, ok := legacyBaselines[fingerprint]
	if !ok {
		return fmt.Errorf("unrecognized SQLite schema %s with empty migration history; restore matching migration history from a verified backup", fingerprint)
	}
	digest := sha256.New()
	for i, file := range files {
		content, err := fs.ReadFile(migrations, file)
		if err != nil {
			return err
		}
		fmt.Fprintf(digest, "%s\x00%s\x00", file, strings.ReplaceAll(string(content), "\r\n", "\n"))
		if file != baseline.lastFile {
			continue
		}
		if fmt.Sprintf("%x", digest.Sum(nil)) != baseline.migrationDigest {
			break
		}
		for _, known := range files[:i+1] {
			if _, err := tx.Exec("INSERT INTO schema_migrations (filename) VALUES (?)", known); err != nil {
				return err
			}
			applied[known] = true
		}
		return tx.Commit()
	}
	return fmt.Errorf("SQLite migration files do not match the verified legacy baseline ending at %s", baseline.lastFile)
}
