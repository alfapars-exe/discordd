// Package services — BackupService periodically snapshots the SQLite DB
// and the uploads directory to a Hugging Face Storage Bucket, providing
// disaster-recovery insurance independent of the HF Space's own
// Persistent Storage.
//
// Design notes:
//   - SQLite snapshot uses `sqlite3 VACUUM INTO` (CLI), not a file copy.
//     VACUUM INTO produces a consistent file even while the app is
//     actively writing; a plain `cp` of a WAL-mode DB risks a torn page.
//   - Uploads are mirrored with `hf sync --delete` so the backup matches
//     production exactly (deletions are mirrored). For a versioned
//     history layer, run a second sync to a dated subpath periodically.
//   - The HF CLI is invoked via `exec.Command` rather than a Go SDK
//     because no first-party Go SDK exists; the Python package ships an
//     `hf` binary that we install in the Dockerfile.
//   - Disabled when HF_TOKEN is empty — graceful no-op so dev / self-host
//     deployments without HF credentials boot without errors.
package services

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/argeinfina/hichat/config"
	"github.com/argeinfina/hichat/models"
)

// BackupAppLogger is the subset of the structured logger this service
// uses. Defined locally so the package doesn't need to import the
// concrete app_log_service implementation.
type BackupAppLogger interface {
	Log(level models.LogLevel, category models.LogCategory, userID, serverID *string, message string, metadata map[string]string)
}

// BackupService runs periodic disaster-recovery snapshots to an HF Bucket.
type BackupService struct {
	cfg       config.BackupConfig
	appLogger BackupAppLogger
	stop      chan struct{}
}

// NewBackupService constructs a BackupService. Call Start() to begin the
// background goroutine.
func NewBackupService(cfg config.BackupConfig) *BackupService {
	return &BackupService{
		cfg:  cfg,
		stop: make(chan struct{}),
	}
}

// SetAppLogger wires the structured logger so backup events surface in
// the admin panel alongside other lifecycle events.
func (b *BackupService) SetAppLogger(l BackupAppLogger) {
	b.appLogger = l
}

// Start launches the background goroutine that runs backups on the
// configured interval. No-op when the service is disabled (no HF_TOKEN).
//
// Lifecycle:
//   - Wait 5 minutes after boot before the first run — gives the DB
//     time to apply pending migrations, lets the app settle, and avoids
//     compounding load with cold-start traffic spikes.
//   - Then run on cfg.Interval (default 24h).
//   - Each run is best-effort: failures are logged but never block the
//     next cycle.
func (b *BackupService) Start() {
	if !b.cfg.Enabled {
		log.Printf("[backup] disabled (HF_TOKEN not set)")
		return
	}
	log.Printf("[backup] enabled — bucket=%s interval=%s", b.cfg.HFBucket, b.cfg.Interval)

	go func() {
		// Initial delay: let migrations + warm caches settle before the
		// first heavy I/O cycle.
		select {
		case <-time.After(5 * time.Minute):
		case <-b.stop:
			return
		}
		b.runBackup()

		ticker := time.NewTicker(b.cfg.Interval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				b.runBackup()
			case <-b.stop:
				return
			}
		}
	}()
}

// Stop signals the background goroutine to exit. Safe to call multiple
// times.
func (b *BackupService) Stop() {
	select {
	case <-b.stop:
		// already closed
	default:
		close(b.stop)
	}
}

// runBackup performs one full snapshot cycle: DB + uploads → HF Bucket.
// Errors are logged but do not propagate; each step's failure is
// independent of the others.
func (b *BackupService) runBackup() {
	start := time.Now()
	log.Printf("[backup] cycle start")
	b.logInfo("backup cycle started", nil)

	if err := os.MkdirAll(b.cfg.WorkDir, 0o755); err != nil {
		b.fail("workdir mkdir", err)
		return
	}

	// 1. SQLite snapshot via VACUUM INTO — produces a consistent file
	//    even while the app continues writing. The output is a single
	//    page-aligned DB; no WAL/SHM sidecar needed for restore.
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
		log.Printf("[backup] sqlite snapshot ok (%s)", time.Since(dbStart))
	}

	// 2. Upload DB snapshot — single file `cp` to the bucket's
	//    `db/hichat.db` path. Overwrite-in-place; HF Buckets are mutable.
	if _, err := os.Stat(snapshotPath); err == nil {
		dbUploadStart := time.Now()
		if err := b.hfCopy(snapshotPath, "db/hichat.db"); err != nil {
			b.fail("hf cp db", err)
		} else {
			log.Printf("[backup] db upload ok (%s)", time.Since(dbUploadStart))
		}
	}

	// 3. Mirror uploads directory — `hf sync --delete` keeps the bucket
	//    bit-for-bit aligned with the live tree. Xet deduplication means
	//    unchanged files don't re-upload.
	uploadsStart := time.Now()
	if err := b.hfSyncDir(b.cfg.UploadDir, "uploads"); err != nil {
		b.fail("hf sync uploads", err)
	} else {
		log.Printf("[backup] uploads sync ok (%s)", time.Since(uploadsStart))
	}

	// Cleanup: remove the local snapshot so it doesn't accumulate on
	// /data between cycles. The next run rebuilds from scratch.
	_ = os.Remove(snapshotPath)

	total := time.Since(start)
	log.Printf("[backup] cycle complete (%s)", total)
	b.logInfo("backup cycle complete", map[string]string{
		"duration_seconds": fmt.Sprintf("%.0f", total.Seconds()),
		"bucket":           b.cfg.HFBucket,
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
	cmd := exec.CommandContext(ctx, "sqlite3", b.cfg.DBPath, stmt)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("sqlite3 vacuum: %w (output: %s)", err, string(out))
	}
	return nil
}

// hfCopy uploads a single file to the bucket at the given subpath
// (relative to the bucket's `latest/` prefix). Uses `hf buckets cp`.
func (b *BackupService) hfCopy(srcFile, destSubpath string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	dest := fmt.Sprintf("hf://buckets/%s/latest/%s", b.cfg.HFBucket, destSubpath)
	cmd := exec.CommandContext(ctx, "hf", "buckets", "cp", srcFile, dest)
	cmd.Env = b.hfEnv()
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("hf cp: %w (output: %s)", err, truncate(string(out), 1024))
	}
	return nil
}

// hfSyncDir mirrors a local directory tree to the bucket at the given
// subpath. `--delete` propagates deletions so the backup reflects the
// live state exactly. Xet deduplication minimises re-uploads.
func (b *BackupService) hfSyncDir(srcDir, destSubpath string) error {
	// Sanity: skip if the source doesn't exist — common on a fresh
	// deploy where no uploads have happened yet.
	if _, err := os.Stat(srcDir); err != nil {
		log.Printf("[backup] source dir missing, skipping: %s", srcDir)
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Minute)
	defer cancel()

	dest := fmt.Sprintf("hf://buckets/%s/latest/%s", b.cfg.HFBucket, destSubpath)
	cmd := exec.CommandContext(ctx, "hf", "sync", srcDir, dest, "--delete")
	cmd.Env = b.hfEnv()
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("hf sync: %w (output: %s)", err, truncate(string(out), 1024))
	}
	return nil
}

// hfEnv returns the env slice for the hf CLI subprocess with HF_TOKEN
// injected. We avoid putting HF_TOKEN into os.Environ() at process boot
// because Go's default env propagates to every child — keeping it scoped
// to the hf invocation limits accidental exposure (e.g. ffmpeg crash
// dumps that capture env).
func (b *BackupService) hfEnv() []string {
	env := os.Environ()
	env = append(env,
		"HF_TOKEN="+b.cfg.HFToken,
		// Enable hf_transfer (Rust-based parallel uploader) when present
		// — falls back to pure-Python silently if hf_transfer isn't installed.
		"HF_HUB_ENABLE_HF_TRANSFER=1",
	)
	return env
}

func (b *BackupService) logInfo(msg string, meta map[string]string) {
	if b.appLogger != nil {
		b.appLogger.Log(models.LogLevelInfo, models.LogCategoryGeneral, nil, nil, msg, meta)
	}
}

func (b *BackupService) logError(msg string, meta map[string]string) {
	if b.appLogger != nil {
		b.appLogger.Log(models.LogLevelError, models.LogCategoryGeneral, nil, nil, msg, meta)
	}
}

func (b *BackupService) fail(step string, err error) {
	log.Printf("[backup] %s failed: %v", step, err)
	b.logError("backup step failed", map[string]string{
		"step":  step,
		"error": truncate(err.Error(), 512),
	})
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
