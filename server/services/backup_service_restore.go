// backup_service_restore.go: boot-time restore of the DB snapshot and uploads tree from the HF Bucket.
package services

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/pkg"
)

// Restore pulls the latest DB snapshot from the HF Bucket into cfg.DBPath
// when the local file is missing or near-empty. Intended to be called
// once at process start, *before* database.New, so migrations run on
// the recovered state.
//
// Returns nil (no-op) when:
//   - cfg.Enabled == false (HF_TOKEN unset → self-host path)
//   - cfg.DBPath is a remote libSQL/Turso DSN
//   - the file already exists and is >= 4 KiB (and BACKUP_FORCE_RESTORE != "1")
//   - the bucket has no snapshot yet (fresh deploy, "404 / not found")
//   - the downloaded snapshot fails PRAGMA integrity_check
//
// In all of the above the caller continues with whatever DB state was
// already on disk; an empty file just means migrations build the schema
// from scratch. The only fatal-ish failure (returned as an error to the
// caller) is the rare case where the staging file lands but cannot be
// moved into place — main.go logs and continues either way, so even
// this is best-effort.
//
// Uploads are restored asynchronously after the DB so the HTTP server
// can come up promptly even when the uploads dir is large; attachments
// will 404 briefly while the goroutine catches up.
func (b *BackupService) Restore(ctx context.Context) error {
	if !b.cfg.Enabled {
		backupLogger.Info("restore skipped: disabled (HF_TOKEN not set)")
		return nil
	}
	if database.IsRemoteLibSQL(b.cfg.DBPath) {
		backupLogger.Info("restore skipped: remote DSN, upstream is already persistent", "dsn", database.RedactDSN(b.cfg.DBPath))
		return nil
	}

	force := os.Getenv("BACKUP_FORCE_RESTORE") == "1"
	if !force {
		if info, err := os.Stat(b.cfg.DBPath); err == nil && info.Size() >= 4096 {
			backupLogger.Info("restore skipped: existing DB found, set BACKUP_FORCE_RESTORE=1 to override",
				"db_path", b.cfg.DBPath, "size_bytes", info.Size())
			// Still try uploads — restart may have wiped uploads even if
			// DB survived (mixed-mount edge case on some HF tiers).
			b.startUploadsRestoreAsync()
			return nil
		}
	}

	backupLogger.Info("restore start", "bucket", b.cfg.HFBucket, "force", force)
	b.logInfo("restore start", map[string]string{"bucket": b.cfg.HFBucket})

	// 0o750 matches the DB-dir convention in database.go — no "other" access.
	if err := os.MkdirAll(b.cfg.WorkDir, 0o750); err != nil {
		return fmt.Errorf("restore workdir mkdir: %w", err)
	}

	tmpPath := filepath.Join(b.cfg.WorkDir, "restore-hichat.db")
	// Clean any half-downloaded leftover from a previous failed restore.
	_ = os.Remove(tmpPath)

	if err := b.hfDownloadFile(ctx, "db/hichat.db", tmpPath); err != nil {
		// "404 / not found" → bucket is empty (fresh deploy). Not fatal.
		if isHFNotFound(err) {
			backupLogger.Info("restore skipped: no snapshot in bucket yet (fresh deploy)")
			b.logInfo("restore skipped: bucket empty", nil)
			b.startUploadsRestoreAsync()
			return nil
		}
		_ = os.Remove(tmpPath)
		// Surface the failure to the caller; main.go decides whether to
		// keep booting (it does — boots with an empty DB and lets the
		// next periodic backup take over).
		return fmt.Errorf("download db snapshot: %w", err)
	}

	info, statErr := os.Stat(tmpPath)
	if statErr != nil || info.Size() < 4096 {
		backupLogger.Warn("restore skipped: downloaded file is empty or missing", "stat_err", pkg.ErrText(statErr), "size_bytes", sizeOf(info))
		_ = os.Remove(tmpPath)
		return nil
	}

	if err := b.verifyDBIntegrity(ctx, tmpPath); err != nil {
		backupLogger.Error("restore skipped: integrity check failed", "err", pkg.ErrText(err))
		b.logError("restore integrity check failed", map[string]string{"error": truncate(pkg.ErrText(err), 256)})
		_ = os.Remove(tmpPath)
		return nil
	}

	if err := os.MkdirAll(filepath.Dir(b.cfg.DBPath), 0o750); err != nil {
		return fmt.Errorf("create db parent dir: %w", err)
	}

	if err := os.Rename(tmpPath, b.cfg.DBPath); err != nil {
		// Rename across filesystems can fail with EXDEV; fall back to copy+remove.
		if copyErr := copyFile(tmpPath, b.cfg.DBPath); copyErr != nil {
			return fmt.Errorf("rename/copy snapshot into place: rename=%w copy=%v", err, copyErr)
		}
		_ = os.Remove(tmpPath)
	}

	backupLogger.Info("restore ok", "db_path", b.cfg.DBPath, "size_bytes", info.Size())
	b.logInfo("restore ok", map[string]string{
		"db_bytes": fmt.Sprintf("%d", info.Size()),
		"source":   "hf-bucket",
	})

	b.startUploadsRestoreAsync()
	return nil
}

// startUploadsRestoreAsync kicks off the uploads-dir restore in a
// goroutine — it's typically much larger than the DB, but the app stays
// useful while it streams down (only attachments / avatars 404 until
// they land). Errors are logged only.
//
// The goroutine is tracked by uploadsRestoreWG; Add(1) happens here
// (synchronously, before the goroutine starts and before Restore returns)
// so callers can Wait on completion without an Add-after-Wait race.
//
// Its context descends from svcCtx, so Stop() tears the transfer down
// promptly. The 60-minute timeout remains as the upper bound for a caller
// that never stops the service.
func (b *BackupService) startUploadsRestoreAsync() {
	parent := b.svcCtx
	if parent == nil {
		parent = context.Background()
	}
	b.uploadsRestoreWG.Add(1)
	go func() {
		defer b.uploadsRestoreWG.Done()
		ctx, cancel := context.WithTimeout(parent, 60*time.Minute)
		defer cancel()
		if err := b.restoreUploadsFromBucket(ctx); err != nil {
			backupLogger.Error("uploads restore failed", "err", pkg.ErrText(err))
			b.logError("uploads restore failed", map[string]string{"error": truncate(pkg.ErrText(err), 256)})
		}
	}()
}

// waitForUploadsRestore blocks until the async uploads-restore goroutine
// started by Restore has finished. It makes completion observable so the
// caller can act on the post-restore state deterministically — tests await
// it before asserting on recorded subprocess calls (avoiding a race with
// the goroutine). Returns immediately when no restore is in flight.
func (b *BackupService) waitForUploadsRestore() {
	b.uploadsRestoreWG.Wait()
}

// restoreUploadsFromBucket mirrors the bucket's uploads/ subtree into
// cfg.UploadDir when the local dir is missing or empty. `hf sync` is
// invoked WITHOUT --delete on purpose — restore must never destroy data
// that already exists locally; the periodic backup will reconcile.
func (b *BackupService) restoreUploadsFromBucket(ctx context.Context) error {
	if b.cfg.UploadDir == "" {
		return nil
	}

	// Skip if uploads dir is already populated. Catches the "DB was
	// wiped but uploads survived" case as well as normal warm boots.
	if entries, err := os.ReadDir(b.cfg.UploadDir); err == nil && len(entries) > 0 {
		backupLogger.Info("uploads restore skipped: dir already populated", "upload_dir", b.cfg.UploadDir, "entries", len(entries))
		return nil
	}

	if err := os.MkdirAll(b.cfg.UploadDir, 0o750); err != nil {
		return fmt.Errorf("uploads dir mkdir: %w", err)
	}

	backupLogger.Info("uploads restore start", "bucket", b.cfg.HFBucket, "upload_dir", b.cfg.UploadDir)
	src := fmt.Sprintf("hf://buckets/%s/latest/uploads", b.cfg.HFBucket)
	out, err := b.runCmd(ctx, b.hfEnv(), "hf", "sync", src, b.cfg.UploadDir)
	if err != nil {
		// 404 means no uploads have been backed up yet — fresh-deploy is
		// the normal path through this branch.
		joined := string(out) + " " + err.Error()
		if isHFNotFoundMsg(joined) {
			backupLogger.Info("uploads restore skipped: no uploads in bucket yet")
			return nil
		}
		return fmt.Errorf("hf sync (restore): %w (output: %s)", err, truncate(string(out), 1024))
	}
	backupLogger.Info("uploads restore ok")
	b.logInfo("uploads restore ok", nil)
	return nil
}

// hfDownloadFile fetches a single object from the bucket into destPath.
// Symmetrical to hfCopy but reversed (`hf buckets cp` accepts either
// direction). Returns an error wrapping the combined stdout/stderr so
// the caller can sniff for "404 / not found".
func (b *BackupService) hfDownloadFile(ctx context.Context, srcSubpath, destPath string) error {
	src := fmt.Sprintf("hf://buckets/%s/latest/%s", b.cfg.HFBucket, srcSubpath)
	out, err := b.runCmd(ctx, b.hfEnv(), "hf", "buckets", "cp", src, destPath)
	if err != nil {
		return &hfError{
			stage:  "buckets cp (download)",
			output: string(out),
			err:    err,
		}
	}
	return nil
}

// verifyDBIntegrity runs `sqlite3 <path> "PRAGMA integrity_check;"` and
// returns nil iff the single-line output is "ok". Catches torn pages or
// a partially-downloaded snapshot before we move it on top of the live
// DB path.
func (b *BackupService) verifyDBIntegrity(ctx context.Context, path string) error {
	checkCtx, cancel := context.WithTimeout(ctx, 1*time.Minute)
	defer cancel()
	out, err := b.runCmd(checkCtx, nil, "sqlite3", path, "PRAGMA integrity_check;")
	if err != nil {
		return fmt.Errorf("sqlite3 integrity_check: %w (output: %s)", err, truncate(string(out), 256))
	}
	first := strings.TrimSpace(string(out))
	// PRAGMA integrity_check returns "ok" on a clean DB or a multi-line
	// list of errors otherwise. We only accept the single-line "ok".
	if first != "ok" {
		return fmt.Errorf("integrity_check returned: %s", truncate(first, 256))
	}
	return nil
}
