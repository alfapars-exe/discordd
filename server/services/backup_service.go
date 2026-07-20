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
//     production exactly (deletions are mirrored).
//   - Two prefixes are written. `latest/` is the mutable mirror (DB +
//     uploads), overwritten every cycle. `daily/<YYYY-MM-DD>/hichat.db` is
//     the versioned history — DB only, one copy per UTC day, pruned to
//     cfg.DailyKeep. `latest/` alone cannot survive silent corruption,
//     because every cycle overwrites the last good copy; the dated copies
//     are what make point-in-time recovery possible. Uploads are not
//     versioned on purpose: a dated copy of a multi-GB media tree per day
//     would multiply the bucket budget by the retention window.
//   - A snapshot is verified (PRAGMA integrity_check) BEFORE it is
//     promoted into `latest/`, so a torn snapshot fails its own cycle
//     instead of clobbering the last known-good backup.
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
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/argeinfina/hichat/config"
	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/logx"
)

var backupLogger = logx.Component("service.backup")

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
	// the goroutine. Stop() cancels the goroutine via svcCtx; callers that
	// also need to *wait* for it to unwind use waitForUploadsRestore.
	uploadsRestoreWG sync.WaitGroup

	// svcCtx bounds every background operation the service owns — today
	// just the async uploads restore. Stop() cancels it, so shutdown no
	// longer leaves a detached multi-GB download running against a process
	// that is trying to exit (it used to hang off its own 60-minute
	// context with no link to b.stop, so the only thing that ended it was
	// the timeout).
	//
	// Deliberately NOT used by the backup cycle: Shutdown() calls Stop()
	// first and *then* runs the final DB backup, so binding cycle work to
	// svcCtx would cancel the very upload that shutdown exists to perform.
	svcCtx    context.Context
	svcCancel context.CancelFunc

	// backupMu serializes backup cycles (single-flight) so the periodic
	// ticker and a shutdown-triggered final backup never run VACUUM INTO
	// against the same workdir snapshot path at the same time. Also guards
	// lastDailyDate, which is only ever read/written inside a cycle.
	backupMu sync.Mutex

	// lastDailyDate is the UTC calendar date (YYYY-MM-DD) whose versioned
	// snapshot has already been written to daily/<date>/hichat.db. It caps
	// the dated copy at one per day even though cycles run hourly.
	lastDailyDate string

	// now is the clock seam, defaulting to time.Now. The daily rotation
	// keys off the UTC calendar date, so tests pin this instead of racing
	// a real midnight boundary. Same motivation as the runCmd seam: keep
	// the decision logic exercisable without the environment.
	now func() time.Time
}

// NewBackupService constructs a BackupService. Call Start() to begin the
// background goroutine.
func NewBackupService(cfg config.BackupConfig) *BackupService {
	svcCtx, svcCancel := context.WithCancel(context.Background())
	return &BackupService{
		cfg:       cfg,
		stop:      make(chan struct{}),
		runCmd:    defaultRunCmd,
		svcCtx:    svcCtx,
		svcCancel: svcCancel,
		now:       time.Now,
	}
}

// nowUTC reads the clock through the seam. Defensive against a
// zero-value BackupService built by a struct literal rather than the
// constructor — a nil seam falls back to the real clock instead of
// panicking.
func (b *BackupService) nowUTC() time.Time {
	if b.now != nil {
		return b.now().UTC()
	}
	return time.Now().UTC()
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
		backupLogger.Info("disabled (HF_TOKEN not set)")
		return
	}
	backupLogger.Info("enabled", "bucket", b.cfg.HFBucket, "interval", b.cfg.Interval)

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

// Stop signals the background goroutine to exit and cancels the service's
// background work (the async uploads restore). Safe to call multiple times
// — context.CancelFunc is idempotent.
func (b *BackupService) Stop() {
	select {
	case <-b.stop:
		// already closed
	default:
		close(b.stop)
	}
	if b.svcCancel != nil {
		b.svcCancel()
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
		backupLogger.Info("shutdown backup skipped: disabled (HF_TOKEN not set)")
		return
	}
	if database.IsRemoteLibSQL(b.cfg.DBPath) {
		backupLogger.Info("shutdown backup skipped: remote DSN, already persistent")
		return
	}

	backupLogger.Info("shutdown backup: final DB snapshot before exit")
	done := make(chan struct{})
	go func() {
		defer close(done)
		b.runBackupCore(true /* dbOnly */)
	}()
	select {
	case <-done:
		backupLogger.Info("shutdown backup complete")
	case <-ctx.Done():
		backupLogger.Warn("shutdown backup did not finish before deadline, process exiting", "err", pkg.ErrText(ctx.Err()))
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

// ── Versioned history (daily/<YYYY-MM-DD>/hichat.db) ──

// dailyDateLayout is the calendar-date format used for the dated prefixes.
// It is chosen so lexicographic order equals chronological order, which is
// what lets pruneDailySnapshots sort with a plain string sort.
const dailyDateLayout = "2006-01-02"

// defaultDailyKeep mirrors config.defaultBackupDailyKeep for a zero-value
// BackupConfig (tests, self-host callers that build the struct directly).
const defaultDailyKeep = 7

// dailyDateRe is the shape gate for anything that becomes part of a delete
// path. Strict anchored match — no prefixes, no suffixes, no separators.
var dailyDateRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// dailyPrefix is the bucket URI prefix that versioned snapshots live under.
// Every path this service deletes is built from it; see removeDailySnapshot.
func (b *BackupService) dailyPrefix() string {
	return fmt.Sprintf("hf://buckets/%s/daily/", b.cfg.HFBucket)
}

// rotateDailySnapshot writes the just-verified snapshot a second time to
// daily/<YYYY-MM-DD>/hichat.db (UTC), at most once per calendar day, then
// prunes the oldest dated copies.
//
// Only the DB is rotated. Uploads stay `latest/`-only because a dated copy
// of a multi-GB media tree per day would blow the bucket budget, while the
// DB is small enough that a week of history is nearly free.
//
// In remote-Turso mode this is unreachable — runBackupCore skips the whole
// DB snapshot step there — so rotation is a no-op in that configuration and
// Turso's own PITR is the DB history.
//
// lastDailyDate is in-memory only, so the first cycle after a restart
// re-uploads the current day's copy. That is harmless: the destination path
// is identical and the write is an idempotent overwrite of the same day.
//
// Caller must hold backupMu (runBackupCore does).
func (b *BackupService) rotateDailySnapshot(ctx context.Context, snapshotPath string) {
	today := b.nowUTC().Format(dailyDateLayout)
	if today == b.lastDailyDate {
		return
	}

	dest := b.dailyPrefix() + today + "/hichat.db"
	if err := b.hfCopyURI(snapshotPath, dest); err != nil {
		b.fail("hf cp daily", err)
		// lastDailyDate stays unset so the next cycle retries today rather
		// than leaving a hole in the history for a transient upload error.
		return
	}
	b.lastDailyDate = today
	backupLogger.Info("daily snapshot ok", "dest", dest)

	// Prune only after a successful rotation, so the listing costs one
	// round-trip per day rather than one per hourly cycle.
	b.pruneDailySnapshots(ctx, today)
}

// pruneDailySnapshots deletes dated snapshots beyond the retention window.
//
// FAIL-SAFE CONTRACT: this function deletes nothing unless it can read the
// bucket listing confidently. A failed listing, an unparseable payload, or
// a payload with no recognisable `daily/<date>` paths all take the same
// branch — log and return. Over-retaining costs storage; deleting on a
// misread listing can destroy the only surviving history, so ambiguity
// always resolves toward keeping data.
func (b *BackupService) pruneDailySnapshots(ctx context.Context, today string) {
	keep := b.cfg.DailyKeep
	if keep <= 0 {
		keep = defaultDailyKeep
	}

	listCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()

	// `--format json` rather than the human table: we need to distinguish
	// "empty prefix" from "output we don't understand", and a machine
	// format makes that a decode error instead of a guess about columns.
	// `--recursive` so entries carry their full `daily/<date>/…` path —
	// the parser requires that prefix as proof an entry is a snapshot dir.
	uri := strings.TrimSuffix(b.dailyPrefix(), "/")
	out, err := b.runCmd(listCtx, b.hfEnv(), "hf", "buckets", "list", uri, "--recursive", "--format", "json")
	if err != nil {
		backupLogger.Error("daily prune skipped: listing failed", "err", pkg.ErrText(err), "output", truncate(string(out), 512))
		return
	}

	dates, ok := parseDailyDates(out)
	if !ok {
		backupLogger.Warn("daily prune skipped: listing had no recognisable daily/<date> paths, refusing to delete on a guess",
			"output", truncate(string(out), 512))
		return
	}
	if len(dates) <= keep {
		return
	}

	// Lexicographic == chronological for YYYY-MM-DD, so the head of the
	// sorted slice is exactly the set that ages out.
	sort.Strings(dates)
	for _, date := range dates[:len(dates)-keep] {
		if date == today {
			// Never prune the copy this cycle just wrote, whatever the
			// listing claimed about ordering.
			continue
		}
		if err := b.removeDailySnapshot(listCtx, date); err != nil {
			b.fail("hf rm daily", err)
		}
	}
}

// parseDailyDates extracts the set of dated prefixes from an
// `hf buckets list --format json` payload. ok=false means "not understood",
// which pruneDailySnapshots treats as "delete nothing".
//
// The walk is schema-agnostic on purpose — the CLI's JSON shape is not a
// documented stability contract, so pinning field names would turn a
// cosmetic CLI change into either a crash or, worse, a wrong delete set.
// Instead every string in the decoded document is tested, and only values
// that are genuinely paths under a `daily/` segment are accepted.
//
// A bare "2026-07-19" is rejected. Without the `daily/` segment we cannot
// prove the string is a snapshot directory rather than some unrelated
// timestamp field the CLI happens to emit, and an unprovable string must
// never become a delete target.
func parseDailyDates(out []byte) ([]string, bool) {
	var doc any
	if err := json.Unmarshal(out, &doc); err != nil {
		return nil, false
	}

	seen := make(map[string]struct{})
	var walk func(v any)
	walk = func(v any) {
		switch t := v.(type) {
		case string:
			if date, ok := dailyDateFromPath(t); ok {
				seen[date] = struct{}{}
			}
		case []any:
			for _, elem := range t {
				walk(elem)
			}
		case map[string]any:
			for _, elem := range t {
				walk(elem)
			}
		}
	}
	walk(doc)

	if len(seen) == 0 {
		// Either the prefix is genuinely empty or the payload isn't what we
		// think it is. We can't tell the two apart, and both mean there is
		// nothing we're confident enough to delete. Reported as not-ok so
		// the caller logs it: pruning that silently never finds anything in
		// production should be visible, not silent.
		return nil, false
	}

	dates := make([]string, 0, len(seen))
	for date := range seen {
		dates = append(dates, date)
	}
	return dates, true
}

// dailyDateFromPath pulls <date> out of a bucket path containing a
// `daily/<date>` segment pair — "daily/2026-07-19",
// "hf://buckets/o/b/daily/2026-07-19/hichat.db", and so on.
//
// It anchors on the LAST "daily" segment so a bucket that happens to be
// named "daily" cannot shift the match onto the wrong segment, and it
// validates via time.Parse so "daily/latest" and "daily/2026-13-45" yield
// nothing.
func dailyDateFromPath(p string) (string, bool) {
	segs := strings.Split(strings.TrimSpace(p), "/")
	idx := -1
	for i, seg := range segs {
		if seg == "daily" {
			idx = i
		}
	}
	if idx < 0 || idx+1 >= len(segs) {
		return "", false
	}
	candidate := segs[idx+1]
	if !dailyDateRe.MatchString(candidate) {
		return "", false
	}
	// Rejects well-shaped impossibilities like 2026-02-30 or 2026-13-01.
	if _, err := time.Parse(dailyDateLayout, candidate); err != nil {
		return "", false
	}
	return candidate, true
}

// removeDailySnapshot deletes one dated snapshot directory.
//
// The target URI is rebuilt from a re-validated date rather than reused
// from whatever the listing said, then checked against the daily/ prefix
// before the CLI runs. That double guard is what makes it impossible for a
// malformed or hostile listing entry (path traversal, a literal "latest",
// an absolute URI pointing at another bucket) to steer a delete at
// `latest/` — the live backup — or anywhere else in the bucket.
func (b *BackupService) removeDailySnapshot(ctx context.Context, date string) error {
	if !dailyDateRe.MatchString(date) {
		return fmt.Errorf("refusing to delete non-date daily prefix %q", date)
	}
	if _, err := time.Parse(dailyDateLayout, date); err != nil {
		return fmt.Errorf("refusing to delete invalid daily date %q: %w", date, err)
	}

	prefix := b.dailyPrefix()
	target := prefix + date
	// Invariant assertion. True by construction today; it exists so a
	// future refactor of how `target` is built cannot quietly widen the
	// blast radius without tripping here first.
	if !strings.HasPrefix(target, prefix) || strings.Contains(target, "/latest/") || strings.HasSuffix(target, "/latest") {
		return fmt.Errorf("refusing to delete out-of-scope path %q", target)
	}

	out, err := b.runCmd(ctx, b.hfEnv(), "hf", "buckets", "remove", target, "--recursive", "--yes")
	if err != nil {
		return fmt.Errorf("hf buckets remove %s: %w (output: %s)", target, err, truncate(string(out), 512))
	}
	backupLogger.Info("daily prune: removed snapshot", "target", target)
	return nil
}

// hfSyncDir mirrors a local directory tree to the bucket at the given
// subpath. `--delete` propagates deletions so the backup reflects the
// live state exactly. Xet deduplication minimises re-uploads.
func (b *BackupService) hfSyncDir(srcDir, destSubpath string) error {
	// Sanity: skip if the source doesn't exist — common on a fresh
	// deploy where no uploads have happened yet.
	if _, err := os.Stat(srcDir); err != nil {
		backupLogger.Info("source dir missing, skipping", "src_dir", srcDir)
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
	backupLogger.Error("backup step failed", "step", step, "err", pkg.ErrText(err))
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
