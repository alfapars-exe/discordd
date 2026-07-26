// backup_service_snapshot.go: periodic snapshot cycle - SQLite VACUUM INTO plus upload to the HF Bucket.
package services

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/argeinfina/hichat/database"
)

// runBackup performs one full periodic snapshot cycle: DB + uploads → HF
// Bucket. Thin wrapper over runBackupCore (full cycle, uploads included).
func (b *BackupService) runBackup() {
	b.runBackupCore(false /* dbOnly */)
}

// runBackupCore performs a single snapshot cycle. It is single-flight
// (backupMu) so the periodic ticker and a shutdown-triggered final backup
// can't run VACUUM INTO against the same workdir path concurrently. When
// dbOnly is true the uploads-mirror step is skipped — used on shutdown,
// where the DB carries the at-risk data and is tiny, and the (potentially
// large) uploads dir is already reconciled by the next boot's restore +
// periodic cycle, so it must not starve the critical DB upload inside HF's
// shutdown grace window. Errors are logged but do not propagate; each step's
// failure is independent of the others.
func (b *BackupService) runBackupCore(dbOnly bool) {
	b.backupMu.Lock()
	defer b.backupMu.Unlock()

	start := time.Now()
	backupLogger.Info("cycle start", "db_only", dbOnly)
	b.logInfo("backup cycle started", map[string]string{"db_only": fmt.Sprintf("%v", dbOnly)})

	if err := os.MkdirAll(b.cfg.WorkDir, 0o750); err != nil {
		b.fail("workdir mkdir", err)
		return
	}

	// 1 & 2. SQLite snapshot + upload — only meaningful for a local DB
	//    file. A remote libSQL/Turso DSN is independently persistent (this
	//    mirrors the remote no-op in Restore above), and the `sqlite3` CLI
	//    cannot open a libsql:// URL anyway — passing one made VACUUM fail
	//    every cycle. So skip the DB snapshot entirely in remote mode; the
	//    uploads mirror below still runs.
	if database.IsRemoteLibSQL(b.cfg.DBPath) {
		backupLogger.Info("db snapshot skipped: remote DSN, upstream is already persistent", "dsn", database.RedactDSN(b.cfg.DBPath))
	} else {
		// SQLite snapshot via VACUUM INTO — produces a consistent file
		// even while the app continues writing. The output is a single
		// page-aligned DB; no WAL/SHM sidecar needed for restore.
		snapshotPath := filepath.Join(b.cfg.WorkDir, "hichat-snapshot.db")
		// VACUUM INTO refuses an existing destination — remove any leftover
		// from a previous failed run before the new snapshot.
		_ = os.Remove(snapshotPath)
		dbStart := time.Now()
		if err := b.snapshotSQLite(snapshotPath); err != nil {
			b.fail("sqlite snapshot", err)
			// Don't bail — still try to mirror uploads. DB snapshot might
			// fail for a transient lock; uploads sync is independent.
		} else {
			backupLogger.Info("sqlite snapshot ok", "duration", time.Since(dbStart))
		}

		// Verify BEFORE promote. The upload below overwrites
		// `latest/db/hichat.db` in place, so shipping an unverified
		// snapshot would replace the last known-good backup with a corrupt
		// one — and nothing would notice until a restore months later, at
		// which point every copy in `latest/` is already bad. Failing the
		// cycle here costs one hour of recovery point; skipping the check
		// can cost the whole backup.
		//
		// context.Background (not svcCtx) deliberately: Shutdown() cancels
		// svcCtx before running its final cycle. See the svcCtx field doc.
		if _, err := os.Stat(snapshotPath); err == nil {
			if err := b.verifyDBIntegrity(context.Background(), snapshotPath); err != nil {
				b.fail("snapshot integrity check", err)
			} else {
				// Upload DB snapshot — single file `cp` to the bucket's
				// `db/hichat.db` path. Overwrite-in-place; HF Buckets are mutable.
				dbUploadStart := time.Now()
				if err := b.hfCopy(snapshotPath, "db/hichat.db"); err != nil {
					b.fail("hf cp db", err)
				} else {
					backupLogger.Info("db upload ok", "duration", time.Since(dbUploadStart))
					// Versioned history: a second, dated copy of the same
					// verified bytes. Only after `latest/` succeeded — the
					// live mirror is the priority, history is the bonus.
					b.rotateDailySnapshot(context.Background(), snapshotPath)
				}
			}
		}

		// Cleanup: remove the local snapshot so it doesn't accumulate on
		// /data between cycles. The next run rebuilds from scratch.
		_ = os.Remove(snapshotPath)
	}

	// 3. Mirror uploads directory — `hf sync --delete` keeps the bucket
	//    bit-for-bit aligned with the live tree. Xet deduplication means
	//    unchanged files don't re-upload. Independent of the DB backend:
	//    uploads live on ephemeral local /data even when the DB is remote.
	//    Skipped on the shutdown (dbOnly) path so the critical DB upload
	//    never starves inside HF's limited shutdown grace window.
	if !dbOnly {
		uploadsStart := time.Now()
		if err := b.hfSyncDir(b.cfg.UploadDir, "uploads"); err != nil {
			b.fail("hf sync uploads", err)
		} else {
			backupLogger.Info("uploads sync ok", "duration", time.Since(uploadsStart))
		}
	}

	total := time.Since(start)
	backupLogger.Info("cycle complete", "duration", total)
	b.logInfo("backup cycle complete", map[string]string{
		"duration_seconds": fmt.Sprintf("%.0f", total.Seconds()),
		"bucket":           b.cfg.HFBucket,
		"db_only":          fmt.Sprintf("%v", dbOnly),
	})
}

// snapshotSQLite runs `sqlite3 <db> 'VACUUM INTO <dest>'` to produce a
// crash-consistent snapshot of the live database.
//
// VACUUM INTO is the documented SQLite mechanism for atomic snapshotting
// while the source DB is open — it acquires a read lock, copies pages
// into a new file, and releases. The resulting file is a self-contained
// DB with no WAL sidecar.
func (b *BackupService) snapshotSQLite(destPath string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	// Quoted-path SQL — Go's exec doesn't run a shell, so we pass the
	// VACUUM INTO statement as a single arg with single-quoted path.
	stmt := fmt.Sprintf("VACUUM INTO '%s'", destPath)
	out, err := b.runCmd(ctx, nil, "sqlite3", b.cfg.DBPath, stmt)
	if err != nil {
		// The sqlite3 CLI echoes the DB path it was handed in its error
		// output; for a libsql:// DSN that path carries an authToken=<jwt>
		// credential. Redact it before it reaches the error — otherwise it
		// leaks verbatim through fail()'s log call and the app-logger.
		return fmt.Errorf("sqlite3 vacuum: %w (output: %s)", err, database.RedactDSN(string(out)))
	}
	return nil
}

// hfCopy uploads a single file to the bucket at the given subpath
// (relative to the bucket's `latest/` prefix). Uses `hf buckets cp`.
func (b *BackupService) hfCopy(srcFile, destSubpath string) error {
	return b.hfCopyURI(srcFile, fmt.Sprintf("hf://buckets/%s/latest/%s", b.cfg.HFBucket, destSubpath))
}

// hfCopyURI is the single-file upload primitive behind hfCopy and the
// daily rotation. It takes a fully-qualified `hf://` destination because
// the dated snapshots live under `daily/`, outside the `latest/` prefix
// that hfCopy hardcodes.
func (b *BackupService) hfCopyURI(srcFile, destURI string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	out, err := b.runCmd(ctx, b.hfEnv(), "hf", "buckets", "cp", srcFile, destURI)
	if err != nil {
		return fmt.Errorf("hf cp: %w (output: %s)", err, truncate(string(out), 1024))
	}
	return nil
}

// dailyPrefix is the bucket URI prefix that versioned snapshots live under.
// Every path this service deletes is built from it; see removeDailySnapshot.
func (b *BackupService) dailyPrefix() string {
	return fmt.Sprintf("hf://buckets/%s/daily/", b.cfg.HFBucket)
}
