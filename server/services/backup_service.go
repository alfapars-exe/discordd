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
//
// Boot-time Restore (Restore):
//   - When the local DBPath is missing or near-empty, main.go invokes
//     Restore *before* database.New, pulling the latest snapshot from
//     `latest/db/hichat.db` into place so migrations + the runtime see
//     the recovered state. Required on HF Spaces without paid Persistent
//     Storage where /data is wiped on every restart/rebuild.
//   - Uploads are restored asynchronously (goroutine) after the DB —
//     they're typically much larger than the DB and the app stays useful
//     while they trickle in (only attachments / avatars 404 until they
//     land).
//   - A successful restore is a no-op when (a) HF_TOKEN is unset, (b) the
//     DSN is a remote libSQL/Turso URL, or (c) the local DB file is
//     already non-empty. Set BACKUP_FORCE_RESTORE=1 to override (c) for
//     manual recovery scenarios.
//
// Testability:
//   - All subprocess invocations go through the runCmd field so tests
//     can swap in a fake without touching exec.Command. Production uses
//     defaultRunCmd which wraps exec.CommandContext.
package services

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/argeinfina/hichat/config"
	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

// cmdRunner is the indirection that makes BackupService testable. Production
// uses defaultRunCmd (wraps exec.CommandContext); tests inject a fake to
// avoid spawning real `hf` / `sqlite3` subprocesses. env=nil means the
// process environment is inherited unchanged.
type cmdRunner func(ctx context.Context, env []string, name string, args ...string) ([]byte, error)

func defaultRunCmd(ctx context.Context, env []string, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	if env != nil {
		cmd.Env = env
	}
	return cmd.CombinedOutput()
}

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
	// runCmd is the subprocess indirection — defaults to defaultRunCmd
	// in production, swapped to a fake in tests. Exposed on the struct
	// (not a package var) so multiple BackupService instances in the
	// same test process can have independent fakes.
	runCmd cmdRunner
	// uploadsRestoreWG tracks the in-flight async uploads-restore goroutine
	// launched by Restore (see startUploadsRestoreAsync) so its completion
	// is observable: tests await it (via waitForUploadsRestore) before
	// asserting on recorded subprocess calls, otherwise the assertion races
	// the goroutine. Note: Stop() does NOT currently wait on or cancel this
	// goroutine — it runs on its own 60-minute context, detached from b.stop.
	uploadsRestoreWG sync.WaitGroup

	// backupMu serializes backup cycles (single-flight) so the periodic
	// ticker and a shutdown-triggered final backup never run VACUUM INTO
	// against the same workdir snapshot path at the same time.
	backupMu sync.Mutex
}

// NewBackupService constructs a BackupService. Call Start() to begin the
// background goroutine.
func NewBackupService(cfg config.BackupConfig) *BackupService {
	return &BackupService{
		cfg:    cfg,
		stop:   make(chan struct{}),
		runCmd: defaultRunCmd,
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

// Shutdown stops the periodic ticker, then runs ONE final best-effort,
// DB-only backup so data written since the last cycle reaches the bucket
// before the ephemeral HF container is destroyed. This is what closes the
// data-loss window on graceful (SIGTERM) restarts — e.g. fresh Denetim/audit
// rows the async writer just drained into the local DB would otherwise never
// be uploaded and would vanish on the next boot's restore.
//
// No-op when disabled (no HF_TOKEN) or on a remote libSQL/Turso DSN (already
// durable upstream). The final cycle is DB-only: the DB carries the at-risk
// data and is tiny, while the uploads mirror can be large and is reconciled
// by the next boot's restore + periodic cycle — so it must not starve the
// critical DB upload inside HF's limited shutdown grace window.
//
// The backup runs in a goroutine bounded by ctx: if the (single-flight)
// cycle can't finish before the caller's deadline we log and return so
// process teardown isn't blocked past HF's grace window. MUST be called AFTER
// the audit/app-log services' Stop() has drained their buffers into the DB,
// so the snapshot captures those rows.
func (b *BackupService) Shutdown(ctx context.Context) {
	b.Stop() // halt the periodic ticker first so it can't race this cycle
	if !b.cfg.Enabled {
		log.Printf("[backup] shutdown backup skipped: disabled (HF_TOKEN not set)")
		return
	}
	if database.IsRemoteLibSQL(b.cfg.DBPath) {
		log.Printf("[backup] shutdown backup skipped: remote DSN, already persistent")
		return
	}

	log.Printf("[backup] shutdown backup: final DB snapshot before exit")
	done := make(chan struct{})
	go func() {
		defer close(done)
		b.runBackupCore(true /* dbOnly */)
	}()
	select {
	case <-done:
		log.Printf("[backup] shutdown backup complete")
	case <-ctx.Done():
		log.Printf("[backup] shutdown backup did not finish before deadline: %v (process exiting)", ctx.Err())
	}
}

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
		log.Printf("[backup] restore skipped: disabled (HF_TOKEN not set)")
		return nil
	}
	if database.IsRemoteLibSQL(b.cfg.DBPath) {
		log.Printf("[backup] restore skipped: remote DSN (%s), upstream is already persistent", database.RedactDSN(b.cfg.DBPath))
		return nil
	}

	force := os.Getenv("BACKUP_FORCE_RESTORE") == "1"
	if !force {
		if info, err := os.Stat(b.cfg.DBPath); err == nil && info.Size() >= 4096 {
			log.Printf("[backup] restore skipped: existing DB at %s (%d bytes); set BACKUP_FORCE_RESTORE=1 to override",
				b.cfg.DBPath, info.Size())
			// Still try uploads — restart may have wiped uploads even if
			// DB survived (mixed-mount edge case on some HF tiers).
			b.startUploadsRestoreAsync()
			return nil
		}
	}

	log.Printf("[backup] restore start: bucket=%s force=%v", b.cfg.HFBucket, force)
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
			log.Printf("[backup] restore skipped: no snapshot in bucket yet (fresh deploy)")
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
		log.Printf("[backup] restore skipped: downloaded file is empty or missing (stat err=%v size=%d)", statErr, sizeOf(info))
		_ = os.Remove(tmpPath)
		return nil
	}

	if err := b.verifyDBIntegrity(ctx, tmpPath); err != nil {
		log.Printf("[backup] restore skipped: integrity check failed: %v", err)
		b.logError("restore integrity check failed", map[string]string{"error": truncate(err.Error(), 256)})
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

	log.Printf("[backup] restore ok: %s (%d bytes)", b.cfg.DBPath, info.Size())
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
func (b *BackupService) startUploadsRestoreAsync() {
	b.uploadsRestoreWG.Add(1)
	go func() {
		defer b.uploadsRestoreWG.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Minute)
		defer cancel()
		if err := b.restoreUploadsFromBucket(ctx); err != nil {
			log.Printf("[backup] uploads restore failed: %v", err)
			b.logError("uploads restore failed", map[string]string{"error": truncate(err.Error(), 256)})
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
		log.Printf("[backup] uploads restore skipped: %s already has %d entries", b.cfg.UploadDir, len(entries))
		return nil
	}

	if err := os.MkdirAll(b.cfg.UploadDir, 0o750); err != nil {
		return fmt.Errorf("uploads dir mkdir: %w", err)
	}

	log.Printf("[backup] uploads restore start: bucket=%s → %s", b.cfg.HFBucket, b.cfg.UploadDir)
	src := fmt.Sprintf("hf://buckets/%s/latest/uploads", b.cfg.HFBucket)
	out, err := b.runCmd(ctx, b.hfEnv(), "hf", "sync", src, b.cfg.UploadDir)
	if err != nil {
		// 404 means no uploads have been backed up yet — fresh-deploy is
		// the normal path through this branch.
		joined := string(out) + " " + err.Error()
		if isHFNotFoundMsg(joined) {
			log.Printf("[backup] uploads restore skipped: no uploads in bucket yet")
			return nil
		}
		return fmt.Errorf("hf sync (restore): %w (output: %s)", err, truncate(string(out), 1024))
	}
	log.Printf("[backup] uploads restore ok")
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

// hfError carries the combined output of an `hf` invocation alongside
// the underlying error so callers can sniff for known patterns
// (404 / not found) without re-running the subprocess.
type hfError struct {
	stage  string
	output string
	err    error
}

func (e *hfError) Error() string {
	return fmt.Sprintf("%s: %v (output: %s)", e.stage, e.err, truncate(e.output, 1024))
}

func (e *hfError) Unwrap() error { return e.err }

// isHFNotFound returns true if the wrapped hfError's output indicates
// the bucket object doesn't exist. The CLI doesn't expose a stable exit
// code for this; we sniff the combined output for the phrasings observed
// in the wild.
func isHFNotFound(err error) bool {
	var he *hfError
	if !errors.As(err, &he) {
		return false
	}
	return isHFNotFoundMsg(he.output)
}

func isHFNotFoundMsg(msg string) bool {
	lower := strings.ToLower(msg)
	return strings.Contains(lower, "404") ||
		strings.Contains(lower, "not found") ||
		strings.Contains(lower, "does not exist")
}

// sizeOf returns the size of a FileInfo defensively — info may be nil
// when os.Stat errored.
func sizeOf(info os.FileInfo) int64 {
	if info == nil {
		return 0
	}
	return info.Size()
}

// copyFile is the fallback for os.Rename across filesystems (EXDEV).
// io.Copy streams without loading the whole file into memory.
func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	// 0o600: snapshot copies carry the full DB — owner-only.
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return out.Sync()
}

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
	log.Printf("[backup] cycle start (dbOnly=%v)", dbOnly)
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
		log.Printf("[backup] db snapshot skipped: remote DSN (%s), upstream is already persistent", database.RedactDSN(b.cfg.DBPath))
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
			log.Printf("[backup] sqlite snapshot ok (%s)", time.Since(dbStart))
		}

		// Upload DB snapshot — single file `cp` to the bucket's
		// `db/hichat.db` path. Overwrite-in-place; HF Buckets are mutable.
		if _, err := os.Stat(snapshotPath); err == nil {
			dbUploadStart := time.Now()
			if err := b.hfCopy(snapshotPath, "db/hichat.db"); err != nil {
				b.fail("hf cp db", err)
			} else {
				log.Printf("[backup] db upload ok (%s)", time.Since(dbUploadStart))
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
			log.Printf("[backup] uploads sync ok (%s)", time.Since(uploadsStart))
		}
	}

	total := time.Since(start)
	log.Printf("[backup] cycle complete (%s)", total)
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
		// leaks verbatim through fail()'s log.Printf and the app-logger.
		return fmt.Errorf("sqlite3 vacuum: %w (output: %s)", err, database.RedactDSN(string(out)))
	}
	return nil
}

// hfCopy uploads a single file to the bucket at the given subpath
// (relative to the bucket's `latest/` prefix). Uses `hf buckets cp`.
func (b *BackupService) hfCopy(srcFile, destSubpath string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	dest := fmt.Sprintf("hf://buckets/%s/latest/%s", b.cfg.HFBucket, destSubpath)
	out, err := b.runCmd(ctx, b.hfEnv(), "hf", "buckets", "cp", srcFile, dest)
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
	out, err := b.runCmd(ctx, b.hfEnv(), "hf", "sync", srcDir, dest, "--delete")
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
