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
		"error": truncate(pkg.ErrText(err), 512),
	})
}
