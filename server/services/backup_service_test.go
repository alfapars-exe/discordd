// backup_service_test.go — covers the Restore() decision tree.
//
// The body of Restore is mostly conditional logic + subprocess invocations;
// the only piece we can't exercise here is the actual `hf` CLI behaviour
// against a real bucket. We swap the runCmd field with a fake so the test
// stays hermetic — no network, no /usr/bin/hf, no /usr/bin/sqlite3.
//
// Each test sets up a t.TempDir() workdir + dbpath so they're parallel-
// safe and never collide with one another or with a developer's real
// /tmp/hichat-backup leftovers.

package services

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/argeinfina/hichat/config"
)

// newTestBackupService builds a BackupService wired with a fake runCmd
// and tempdir-scoped paths. The fake captures every invocation so tests
// can assert on what was called (and what wasn't).
func newTestBackupService(t *testing.T, cfg config.BackupConfig) (*BackupService, *fakeRunner) {
	t.Helper()
	if cfg.WorkDir == "" {
		cfg.WorkDir = filepath.Join(t.TempDir(), "workdir")
	}
	svc := NewBackupService(cfg)
	fake := &fakeRunner{}
	svc.runCmd = fake.run
	// Drain any async uploads-restore goroutine before the test's t.TempDir
	// is torn down. Tests that assert on post-restore state wait explicitly
	// mid-test; this fixture-level cleanup makes the no-leak guarantee
	// structural for the rest, so a future test that sets UploadDir can't
	// leave an orphaned goroutine touching the fake or a removed TempDir
	// after the test completes. Cleanups run LIFO, so this drains before the
	// TempDir removal registered above it.
	t.Cleanup(svc.waitForUploadsRestore)
	return svc, fake
}

// fakeRunner records every subprocess call and lets each test program
// a sequence of responses keyed by the executable name. Default response
// is success with empty output.
type fakeRunner struct {
	// mu guards calls: run() appends to it from the async uploads-restore
	// goroutine while the test goroutine reads it (via callsTo/snapshot).
	// responses and handler are set during test setup before any goroutine
	// starts (the `go` in startUploadsRestoreAsync happens-after that
	// setup), so they need no lock.
	mu        sync.Mutex
	calls     []fakeCall
	responses map[string]fakeResponse // keyed by argv[0] ("hf", "sqlite3")
	// handler, if non-nil, overrides the responses map and receives every
	// call. Useful for tests that need to write a real file to a path
	// taken from the args (e.g. the restore staging path). It receives the
	// caller's context so a test can model a long-running transfer by
	// blocking on ctx.Done() — that's how the Stop()-cancels-restore test
	// proves the goroutine is actually bound to the service lifecycle.
	handler func(ctx context.Context, call fakeCall) ([]byte, error)
}

type fakeCall struct {
	name string
	args []string
	env  []string
}

type fakeResponse struct {
	output []byte
	err    error
}

func (f *fakeRunner) run(ctx context.Context, env []string, name string, args ...string) ([]byte, error) {
	f.mu.Lock()
	f.calls = append(f.calls, fakeCall{name: name, args: append([]string(nil), args...), env: env})
	f.mu.Unlock()
	if f.handler != nil {
		return f.handler(ctx, fakeCall{name: name, args: args, env: env})
	}
	if resp, ok := f.responses[name]; ok {
		return resp.output, resp.err
	}
	return nil, nil
}

func (f *fakeRunner) callsTo(name string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if c.name == name {
			n++
		}
	}
	return n
}

// snapshot returns a copy of the recorded calls under the lock, so the test
// goroutine can range over them safely even if a background goroutine is
// still invoking run. Each fakeCall's args/env slices are written once at
// capture and never mutated afterward, so the shallow copy is safe to read.
func (f *fakeRunner) snapshot() []fakeCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]fakeCall(nil), f.calls...)
}

// hfArgv returns the recorded argv of every `hf` invocation, in order, as
// space-joined strings. Assertions read as the literal CLI surface the
// service uses, which is the thing a reviewer actually wants to eyeball.
func (f *fakeRunner) hfArgv() []string {
	var out []string
	for _, c := range f.snapshot() {
		if c.name == "hf" {
			out = append(out, "hf "+strings.Join(c.args, " "))
		}
	}
	return out
}

// hfArgvContaining filters hfArgv down to the invocations mentioning sub.
func (f *fakeRunner) hfArgvContaining(sub string) []string {
	var out []string
	for _, argv := range f.hfArgv() {
		if strings.Contains(argv, sub) {
			out = append(out, argv)
		}
	}
	return out
}

// healthySQLite models a working `sqlite3` CLI for the backup path: a
// `VACUUM INTO '<path>'` actually creates the destination file (so the
// os.Stat gate before the upload passes), and a PRAGMA integrity_check
// reports integrityOut. Pass a corruption report to exercise the
// verify-before-promote guard.
func healthySQLite(integrityOut string) func(context.Context, fakeCall) ([]byte, error) {
	return func(_ context.Context, call fakeCall) ([]byte, error) {
		if call.name != "sqlite3" || len(call.args) == 0 {
			return nil, nil
		}
		stmt := call.args[len(call.args)-1]
		if strings.HasPrefix(stmt, "PRAGMA") {
			return []byte(integrityOut), nil
		}
		if strings.HasPrefix(stmt, "VACUUM INTO") {
			if i := strings.Index(stmt, "'"); i >= 0 {
				if j := strings.LastIndex(stmt, "'"); j > i {
					_ = os.WriteFile(stmt[i+1:j], make([]byte, 8192), 0o640)
				}
			}
		}
		return nil, nil
	}
}

// localBackupService builds a service pointed at a local (non-remote) DB so
// the full snapshot → verify → promote → rotate path runs, with the clock
// pinned so daily rotation never races a real midnight boundary.
func localBackupService(t *testing.T, now time.Time, keep int) (*BackupService, *fakeRunner) {
	t.Helper()
	root := t.TempDir()
	uploadDir := filepath.Join(root, "uploads")
	if err := os.MkdirAll(uploadDir, 0o755); err != nil {
		t.Fatalf("seed uploads dir: %v", err)
	}
	svc, fake := newTestBackupService(t, config.BackupConfig{
		Enabled:   true,
		HFToken:   "fake-token",
		HFBucket:  "test/bucket",
		DBPath:    filepath.Join(root, "data", "hichat.db"),
		UploadDir: uploadDir,
		WorkDir:   filepath.Join(root, "workdir"),
		DailyKeep: keep,
	})
	svc.now = func() time.Time { return now }
	return svc, fake
}

// ── Tests ──

// TestRestore_DisabledNoOp: HF_TOKEN unset → no subprocesses, no error.
// This is the self-host happy path — they don't want HF involvement.
func TestRestore_DisabledNoOp(t *testing.T) {
	t.Parallel()
	dbDir := t.TempDir()
	dbPath := filepath.Join(dbDir, "hichat.db")

	svc, fake := newTestBackupService(t, config.BackupConfig{
		Enabled: false,
		DBPath:  dbPath,
	})

	if err := svc.Restore(context.Background()); err != nil {
		t.Fatalf("Restore err = %v, want nil", err)
	}
	if len(fake.calls) != 0 {
		t.Fatalf("expected zero subprocess calls, got %d (%v)", len(fake.calls), fake.calls)
	}
	if _, err := os.Stat(dbPath); !os.IsNotExist(err) {
		t.Fatalf("expected no DB file at %s, stat err = %v", dbPath, err)
	}
}

// TestRestore_RemoteDSN_NoOp: DATABASE_URL=libsql://... should bypass
// restore entirely; Turso is its own persistence story.
func TestRestore_RemoteDSN_NoOp(t *testing.T) {
	t.Parallel()
	svc, fake := newTestBackupService(t, config.BackupConfig{
		Enabled:  true,
		HFToken:  "fake-token",
		HFBucket: "test/bucket",
		DBPath:   "libsql://example.turso.io",
	})

	if err := svc.Restore(context.Background()); err != nil {
		t.Fatalf("Restore err = %v, want nil", err)
	}
	if len(fake.calls) != 0 {
		t.Fatalf("expected zero subprocess calls for remote DSN, got %d", len(fake.calls))
	}
}

// TestRestore_ExistingNonEmptyDB_NoOp: warm boot — local DB already
// populated, restore should not touch it. We also assert the file bytes
// are unchanged so a future regression that overwrites with a dummy
// won't slip through.
func TestRestore_ExistingNonEmptyDB_NoOp(t *testing.T) {
	t.Parallel()
	dbDir := t.TempDir()
	dbPath := filepath.Join(dbDir, "hichat.db")
	original := make([]byte, 8192)
	for i := range original {
		original[i] = byte(i % 256)
	}
	if err := os.WriteFile(dbPath, original, 0o640); err != nil {
		t.Fatalf("seed DB: %v", err)
	}

	svc, fake := newTestBackupService(t, config.BackupConfig{
		Enabled:   true,
		HFToken:   "fake-token",
		HFBucket:  "test/bucket",
		DBPath:    dbPath,
		UploadDir: filepath.Join(dbDir, "uploads"), // empty -> uploads restore fires
	})

	if err := svc.Restore(context.Background()); err != nil {
		t.Fatalf("Restore err = %v, want nil", err)
	}

	// No DB download should have happened — the only allowed CLI call is
	// the async uploads restore (`hf sync`). Wait for that goroutine to
	// finish so we observe *all* of its calls (and so the read below is
	// synchronized against it), then assert none of them was `hf buckets`.
	svc.waitForUploadsRestore()

	// The warm-boot path must still fire the async uploads restore, so at
	// least one `hf sync` call should be recorded. Assert that so the
	// no-`hf buckets` check below can't pass vacuously (e.g. if a refactor
	// stopped launching the uploads restore altogether).
	if fake.callsTo("hf") == 0 {
		t.Fatal("expected warm-boot to run the async uploads restore (`hf sync`), but no hf call was recorded")
	}
	for _, c := range fake.snapshot() {
		if c.name == "hf" && len(c.args) > 0 && c.args[0] == "buckets" {
			t.Fatalf("did not expect `hf buckets cp` for warm-boot DB, got call %v", c)
		}
	}

	got, err := os.ReadFile(dbPath)
	if err != nil {
		t.Fatalf("re-read DB: %v", err)
	}
	if len(got) != len(original) {
		t.Fatalf("DB size changed: got %d want %d", len(got), len(original))
	}
	for i := range got {
		if got[i] != original[i] {
			t.Fatalf("DB content mutated at byte %d: got %d want %d", i, got[i], original[i])
		}
	}
}

// TestRestore_MissingDB_DownloadsSnapshot: cold boot after Space restart —
// DB file does not exist. Restore must:
//  1. Invoke `hf buckets cp` to download.
//  2. Invoke `sqlite3 PRAGMA integrity_check`.
//  3. Move the file into place at cfg.DBPath.
func TestRestore_MissingDB_DownloadsSnapshot(t *testing.T) {
	t.Parallel()
	rootDir := t.TempDir()
	dbPath := filepath.Join(rootDir, "data", "hichat.db")
	workDir := filepath.Join(rootDir, "workdir")

	svc, fake := newTestBackupService(t, config.BackupConfig{
		Enabled:  true,
		HFToken:  "fake-token",
		HFBucket: "test/bucket",
		DBPath:   dbPath,
		WorkDir:  workDir,
	})

	// Fake the hf download by writing a plausibly-sized payload to the
	// staging path passed in argv. The integrity_check call returns "ok".
	fake.handler = func(_ context.Context, call fakeCall) ([]byte, error) {
		switch call.name {
		case "hf":
			// argv: buckets cp hf://... <destPath>
			if len(call.args) < 4 {
				t.Fatalf("hf call had unexpected argv: %v", call.args)
			}
			destPath := call.args[len(call.args)-1]
			payload := make([]byte, 16384)
			for i := range payload {
				payload[i] = byte(i % 256)
			}
			if err := os.WriteFile(destPath, payload, 0o640); err != nil {
				t.Fatalf("fake hf write: %v", err)
			}
			return nil, nil
		case "sqlite3":
			return []byte("ok\n"), nil
		}
		return nil, nil
	}

	if err := svc.Restore(context.Background()); err != nil {
		t.Fatalf("Restore err = %v, want nil", err)
	}

	if got := fake.callsTo("hf"); got < 1 {
		t.Fatalf("expected at least one hf call, got %d", got)
	}
	if got := fake.callsTo("sqlite3"); got != 1 {
		t.Fatalf("expected exactly one sqlite3 integrity_check call, got %d", got)
	}

	info, err := os.Stat(dbPath)
	if err != nil {
		t.Fatalf("expected restored DB at %s, stat err = %v", dbPath, err)
	}
	if info.Size() != 16384 {
		t.Fatalf("restored DB size = %d, want 16384", info.Size())
	}
}

// TestRestore_HFReturns404_FreshDeploy: bucket has no snapshot yet
// (first-ever deploy). Restore must swallow the 404 silently and leave
// no DB on disk; the caller continues with an empty DB.
func TestRestore_HFReturns404_FreshDeploy(t *testing.T) {
	t.Parallel()
	rootDir := t.TempDir()
	dbPath := filepath.Join(rootDir, "data", "hichat.db")

	svc, fake := newTestBackupService(t, config.BackupConfig{
		Enabled:  true,
		HFToken:  "fake-token",
		HFBucket: "test/bucket",
		DBPath:   dbPath,
		WorkDir:  filepath.Join(rootDir, "workdir"),
	})

	fake.responses = map[string]fakeResponse{
		"hf": {output: []byte("Error: 404 - Not Found"), err: errors.New("exit status 1")},
	}

	if err := svc.Restore(context.Background()); err != nil {
		t.Fatalf("Restore err = %v, want nil for 404", err)
	}
	if _, err := os.Stat(dbPath); !os.IsNotExist(err) {
		t.Fatalf("expected no DB file (fresh deploy), stat err = %v", err)
	}
	if got := fake.callsTo("sqlite3"); got != 0 {
		t.Fatalf("integrity_check must not run when nothing downloaded, got %d calls", got)
	}
}

// TestRestore_CorruptDownload: download succeeds but the sqlite3
// integrity_check rejects it (or it's torn). Restore deletes the staging
// file and returns nil — the caller boots with whatever was on disk (in
// this test, nothing → empty DB).
func TestRestore_CorruptDownload(t *testing.T) {
	t.Parallel()
	rootDir := t.TempDir()
	dbPath := filepath.Join(rootDir, "data", "hichat.db")
	workDir := filepath.Join(rootDir, "workdir")

	svc, fake := newTestBackupService(t, config.BackupConfig{
		Enabled:  true,
		HFToken:  "fake-token",
		HFBucket: "test/bucket",
		DBPath:   dbPath,
		WorkDir:  workDir,
	})

	fake.handler = func(_ context.Context, call fakeCall) ([]byte, error) {
		switch call.name {
		case "hf":
			// Write a believable-size file so the < 4 KiB short-circuit
			// doesn't fire; we want integrity_check to be what rejects it.
			destPath := call.args[len(call.args)-1]
			_ = os.WriteFile(destPath, make([]byte, 8192), 0o640)
			return nil, nil
		case "sqlite3":
			return []byte("*** in database main ***\nPage 5: corrupt"), nil
		}
		return nil, nil
	}

	if err := svc.Restore(context.Background()); err != nil {
		t.Fatalf("Restore err = %v, want nil for corrupt download", err)
	}
	if _, err := os.Stat(dbPath); !os.IsNotExist(err) {
		t.Fatalf("corrupt snapshot must not be promoted into place, stat err = %v", err)
	}
	tmpPath := filepath.Join(workDir, "restore-hichat.db")
	if _, err := os.Stat(tmpPath); !os.IsNotExist(err) {
		t.Fatalf("staging file should be cleaned up, stat err = %v", err)
	}
}

// TestRestore_TooSmallDownload: hf "succeeded" but the file came down
// truncated (e.g. partial transfer reported success). Anything under
// 4 KiB can't be a valid SQLite DB even with an empty schema, so we
// reject without bothering with PRAGMA integrity_check.
func TestRestore_TooSmallDownload(t *testing.T) {
	t.Parallel()
	rootDir := t.TempDir()
	dbPath := filepath.Join(rootDir, "data", "hichat.db")
	workDir := filepath.Join(rootDir, "workdir")

	svc, fake := newTestBackupService(t, config.BackupConfig{
		Enabled:  true,
		HFToken:  "fake-token",
		HFBucket: "test/bucket",
		DBPath:   dbPath,
		WorkDir:  workDir,
	})

	fake.handler = func(_ context.Context, call fakeCall) ([]byte, error) {
		if call.name == "hf" {
			destPath := call.args[len(call.args)-1]
			_ = os.WriteFile(destPath, []byte("partial"), 0o640) // 7 bytes
		}
		return nil, nil
	}

	if err := svc.Restore(context.Background()); err != nil {
		t.Fatalf("Restore err = %v, want nil for tiny download", err)
	}
	if got := fake.callsTo("sqlite3"); got != 0 {
		t.Fatalf("integrity_check must be skipped for tiny files, got %d calls", got)
	}
	if _, err := os.Stat(dbPath); !os.IsNotExist(err) {
		t.Fatalf("tiny snapshot must not be promoted into place, stat err = %v", err)
	}
}

// TestRunBackup_RemoteDSN_SkipsSnapshot: when DATABASE_URL is a remote
// libSQL/Turso DSN, the hourly cycle must NOT shell out to the `sqlite3`
// CLI — the CLI can only open local files and fails on a libsql:// URL,
// which is the bug this guards (the snapshot step failed every cycle).
// Mirrors the existing remote no-op in Restore (Turso is already
// persistent). The uploads mirror is independent of the DB backend —
// uploads live on ephemeral local /data regardless — so it must still run.
func TestRunBackup_RemoteDSN_SkipsSnapshot(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	uploadDir := filepath.Join(root, "uploads")
	if err := os.MkdirAll(uploadDir, 0o755); err != nil {
		t.Fatalf("seed uploads dir: %v", err)
	}

	svc, fake := newTestBackupService(t, config.BackupConfig{
		Enabled:   true,
		HFToken:   "fake-token",
		HFBucket:  "test/bucket",
		DBPath:    "libsql://example.turso.io?authToken=super-secret-jwt",
		UploadDir: uploadDir,
		WorkDir:   filepath.Join(root, "workdir"),
	})

	svc.runBackup()

	if got := fake.callsTo("sqlite3"); got != 0 {
		t.Fatalf("remote DSN must skip the sqlite3 snapshot, got %d sqlite3 call(s)", got)
	}

	var sawDBUpload, sawUploadsSync bool
	for _, c := range fake.snapshot() {
		if c.name != "hf" || len(c.args) == 0 {
			continue
		}
		switch c.args[0] {
		case "buckets": // `hf buckets cp <snapshot> db/hichat.db`
			sawDBUpload = true
		case "sync": // `hf sync <uploadDir> uploads --delete`
			sawUploadsSync = true
		}
	}
	if sawDBUpload {
		t.Fatal("remote DSN must not upload a DB snapshot (`hf buckets cp`) — there is no snapshot")
	}
	if !sawUploadsSync {
		t.Fatal("uploads mirror (`hf sync`) must still run in remote-DSN mode")
	}
}

// TestSnapshotSQLite_RedactsAuthTokenInError: the sqlite3 CLI echoes the
// database path it was given — including a libsql:// DSN's authToken=<jwt>
// query parameter — verbatim in its error output. snapshotSQLite must not
// let that credential reach the returned error (and therefore the logs and
// the app-logger sinks). Regression guard for the DSN-token leak: commit
// dd8ecdc redacted the DSN in other backup logs, but this CLI error-output
// path still printed the token raw.
func TestSnapshotSQLite_RedactsAuthTokenInError(t *testing.T) {
	t.Parallel()
	const secret = "eyJhbGciOiJSUPER-SECRET-TOKEN-eyJzdWIiOiIxMjM0"

	svc, fake := newTestBackupService(t, config.BackupConfig{
		DBPath:  "/data/hichat.db", // local path → exercises the sqlite3 branch
		WorkDir: t.TempDir(),
	})
	fake.responses = map[string]fakeResponse{
		"sqlite3": {
			output: []byte(`Error: unable to open database "libsql://x.turso.io?authToken=` + secret + `": unable to open database file`),
			err:    errors.New("exit status 1"),
		},
	}

	err := svc.snapshotSQLite(filepath.Join(t.TempDir(), "snap.db"))
	if err == nil {
		t.Fatal("expected snapshotSQLite to surface the sqlite3 failure, got nil")
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("snapshot error leaked the authToken JWT: %q", err.Error())
	}
	if !strings.Contains(err.Error(), "authToken=***") {
		t.Fatalf("expected redacted authToken marker in error, got %q", err.Error())
	}
}

// TestShutdown_RunsFinalDBBackup: a graceful shutdown must take ONE final
// DB-only snapshot+upload so writes since the last periodic cycle (e.g. a
// fresh audit-log row drained into the DB by AuditLog.Stop()) reach the
// bucket before the ephemeral container dies. The uploads mirror is
// intentionally skipped on this path to fit HF's limited shutdown window.
func TestShutdown_RunsFinalDBBackup(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	uploadDir := filepath.Join(root, "uploads")
	if err := os.MkdirAll(uploadDir, 0o755); err != nil {
		t.Fatalf("seed uploads dir: %v", err)
	}

	svc, fake := newTestBackupService(t, config.BackupConfig{
		Enabled:   true,
		HFToken:   "fake-token",
		HFBucket:  "test/bucket",
		DBPath:    filepath.Join(root, "data", "hichat.db"), // local → sqlite3 snapshot path
		UploadDir: uploadDir,
		WorkDir:   filepath.Join(root, "workdir"),
	})

	fake.handler = healthySQLite("ok\n")

	svc.Shutdown(context.Background())

	// Two sqlite3 invocations: the VACUUM INTO snapshot, then the
	// PRAGMA integrity_check that gates the promote.
	if got := fake.callsTo("sqlite3"); got != 2 {
		t.Fatalf("shutdown must run VACUUM + integrity_check, got %d sqlite3 call(s)", got)
	}
	var sawDBUpload, sawUploadsSync bool
	for _, c := range fake.snapshot() {
		if c.name != "hf" || len(c.args) == 0 {
			continue
		}
		switch c.args[0] {
		case "buckets": // `hf buckets cp <snapshot> db/hichat.db`
			sawDBUpload = true
		case "sync": // `hf sync <uploadDir> uploads --delete`
			sawUploadsSync = true
		}
	}
	if !sawDBUpload {
		t.Fatal("shutdown must upload the DB snapshot (`hf buckets cp`)")
	}
	if sawUploadsSync {
		t.Fatal("shutdown backup is DB-only — it must NOT run the uploads mirror (`hf sync`)")
	}
}

// TestShutdown_DisabledNoOp: HF_TOKEN unset → shutdown runs no subprocesses.
func TestShutdown_DisabledNoOp(t *testing.T) {
	t.Parallel()
	svc, fake := newTestBackupService(t, config.BackupConfig{
		Enabled: false,
		DBPath:  filepath.Join(t.TempDir(), "hichat.db"),
	})

	svc.Shutdown(context.Background())

	if len(fake.calls) != 0 {
		t.Fatalf("disabled shutdown must run no subprocesses, got %d (%v)", len(fake.calls), fake.calls)
	}
}

// TestShutdown_RemoteDSN_NoOp: a remote libSQL/Turso DSN is already
// persistent upstream — shutdown must not shell out to sqlite3/hf at all.
func TestShutdown_RemoteDSN_NoOp(t *testing.T) {
	t.Parallel()
	svc, fake := newTestBackupService(t, config.BackupConfig{
		Enabled:  true,
		HFToken:  "fake-token",
		HFBucket: "test/bucket",
		DBPath:   "libsql://example.turso.io?authToken=super-secret-jwt",
	})

	svc.Shutdown(context.Background())

	if len(fake.calls) != 0 {
		t.Fatalf("remote-DSN shutdown must run no subprocesses, got %d (%v)", len(fake.calls), fake.calls)
	}
}

// ── Verify-before-promote ──

// TestRunBackup_CorruptSnapshot_SkipsPromote is the whole point of the
// integrity gate: `hf buckets cp` overwrites latest/db/hichat.db in place,
// so promoting a snapshot that failed PRAGMA integrity_check would replace
// the last known-good backup with a corrupt one — undetectable until a
// restore months later. A failed check must fail the cycle and leave
// `latest/` alone.
func TestRunBackup_CorruptSnapshot_SkipsPromote(t *testing.T) {
	t.Parallel()
	svc, fake := localBackupService(t, time.Date(2026, 7, 19, 12, 0, 0, 0, time.UTC), 7)

	// VACUUM produces a file, but it's torn.
	fake.handler = healthySQLite("*** in database main ***\nPage 5: btreeInitPage() returns error code 11")

	svc.runBackup()

	for _, argv := range fake.hfArgv() {
		if strings.Contains(argv, "latest/db") {
			t.Fatalf("corrupt snapshot must never be promoted to latest/db, got: %s", argv)
		}
		if strings.Contains(argv, "/daily/") {
			t.Fatalf("corrupt snapshot must not be rotated into history either, got: %s", argv)
		}
	}

	// The uploads mirror is independent of the DB snapshot and must still
	// run — otherwise this test would pass vacuously if the whole cycle
	// bailed out early.
	if len(fake.hfArgvContaining("sync")) == 0 {
		t.Fatalf("uploads mirror must still run after a failed DB snapshot, got: %v", fake.hfArgv())
	}
}

// TestRunBackup_HealthySnapshot_PromotesAndRotates pins the happy-path CLI
// contract: a verified snapshot goes to latest/ AND to today's dated
// prefix, and a second cycle the same day does not write a second daily.
func TestRunBackup_HealthySnapshot_PromotesAndRotates(t *testing.T) {
	t.Parallel()
	day := time.Date(2026, 7, 19, 12, 0, 0, 0, time.UTC)
	svc, fake := localBackupService(t, day, 7)
	fake.handler = healthySQLite("ok\n")

	svc.runBackup()

	// Cycle 1: exactly one promote + exactly one dated copy.
	latest := fake.hfArgvContaining("latest/db/hichat.db")
	if len(latest) != 1 {
		t.Fatalf("want exactly 1 promote to latest/db, got %d: %v", len(latest), fake.hfArgv())
	}
	daily := fake.hfArgvContaining("/daily/")
	wantDaily := "hf://buckets/test/bucket/daily/2026-07-19/hichat.db"
	var dailyCopies int
	for _, argv := range daily {
		if strings.Contains(argv, "buckets cp") {
			dailyCopies++
			if !strings.Contains(argv, wantDaily) {
				t.Fatalf("daily copy targeted %s, want %s", argv, wantDaily)
			}
		}
	}
	if dailyCopies != 1 {
		t.Fatalf("want exactly 1 dated copy, got %d: %v", dailyCopies, daily)
	}

	// Cycle 2, same UTC day: latest/ refreshes again, history does not.
	svc.runBackup()

	if got := len(fake.hfArgvContaining("latest/db/hichat.db")); got != 2 {
		t.Fatalf("second cycle must refresh latest/db, want 2 promotes total, got %d", got)
	}
	dailyCopies = 0
	for _, argv := range fake.hfArgvContaining("/daily/") {
		if strings.Contains(argv, "buckets cp") {
			dailyCopies++
		}
	}
	if dailyCopies != 1 {
		t.Fatalf("a second cycle on the same UTC day must not write a second daily, got %d dated copies", dailyCopies)
	}

	// Cycle 3, next UTC day: history advances.
	svc.now = func() time.Time { return day.Add(24 * time.Hour) }
	svc.runBackup()

	if got := len(fake.hfArgvContaining("daily/2026-07-20/hichat.db")); got != 1 {
		t.Fatalf("crossing into a new UTC day must write a new dated copy, got %d", got)
	}
}

// ── Prune ──

// listingJSON mirrors real `hf buckets list <uri> --recursive --format json`
// output, captured from hf://buckets/argeinfina/discord (huggingface_hub
// 1.17.0, 2026-07-19): a flat array of file objects whose `path` is relative
// to the BUCKET root, not to the listed prefix.
//
// The extra fields are not decoration. `mtime` and `uploaded_at` carry
// date-shaped strings, so keeping them here proves the parser only accepts a
// date that directly follows a `daily/` segment rather than any date-looking
// text anywhere in the payload. The parser is schema-agnostic by design — it
// walks every string — which is exactly why the fixture has to be faithful.
func listingJSON(dates ...string) []byte {
	var b strings.Builder
	b.WriteString("[")
	for i, d := range dates {
		if i > 0 {
			b.WriteString(",")
		}
		b.WriteString(`{"type":"file","path":"daily/` + d + `/hichat.db","size":8192,` +
			`"xet_hash":"ed95b6fd42244e25111c298604ca0c8cf7252625a99caf8fef0e008fc990114b",` +
			`"mtime":"` + d + `T03:14:07+00:00","uploaded_at":"` + d + `T03:14:07.819000+00:00"}`)
	}
	b.WriteString("]")
	return []byte(b.String())
}

// TestPruneDaily_KeepsNewestN: 9 dated snapshots, keep 7 → exactly the 2
// oldest are removed, newest-first ordering respected.
func TestPruneDaily_KeepsNewestN(t *testing.T) {
	t.Parallel()
	svc, fake := localBackupService(t, time.Date(2026, 7, 9, 12, 0, 0, 0, time.UTC), 7)

	dates := []string{
		"2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04", "2026-07-05",
		"2026-07-06", "2026-07-07", "2026-07-08", "2026-07-09",
	}
	fake.handler = func(_ context.Context, call fakeCall) ([]byte, error) {
		if call.name == "hf" && len(call.args) > 1 && call.args[1] == "list" {
			return listingJSON(dates...), nil
		}
		return nil, nil
	}

	svc.pruneDailySnapshots(context.Background(), "2026-07-09")

	removed := fake.hfArgvContaining("buckets remove")
	want := []string{
		"hf buckets remove hf://buckets/test/bucket/daily/2026-07-01 --recursive --yes",
		"hf buckets remove hf://buckets/test/bucket/daily/2026-07-02 --recursive --yes",
	}
	if len(removed) != len(want) {
		t.Fatalf("want %d removals (9 dates, keep 7), got %d: %v", len(want), len(removed), removed)
	}
	for i := range want {
		if removed[i] != want[i] {
			t.Fatalf("removal %d = %q, want %q", i, removed[i], want[i])
		}
	}
}

// TestPruneDaily_UnderRetention_NoDeletes: fewer snapshots than the
// retention window means nothing ages out.
func TestPruneDaily_UnderRetention_NoDeletes(t *testing.T) {
	t.Parallel()
	svc, fake := localBackupService(t, time.Date(2026, 7, 3, 12, 0, 0, 0, time.UTC), 7)
	fake.handler = func(_ context.Context, call fakeCall) ([]byte, error) {
		if call.name == "hf" && len(call.args) > 1 && call.args[1] == "list" {
			return listingJSON("2026-07-01", "2026-07-02", "2026-07-03"), nil
		}
		return nil, nil
	}

	svc.pruneDailySnapshots(context.Background(), "2026-07-03")

	if removed := fake.hfArgvContaining("buckets remove"); len(removed) != 0 {
		t.Fatalf("3 snapshots with keep=7 must delete nothing, got: %v", removed)
	}
}

// TestPruneDaily_AmbiguousListing_NeverDeletes is the fail-safe contract.
// Every way of failing to read the listing — a non-zero exit, a payload
// that isn't JSON, valid JSON in an unexpected shape, an empty prefix —
// must produce ZERO deletions. Over-retaining costs storage; deleting on a
// misread listing can destroy the only surviving history.
func TestPruneDaily_AmbiguousListing_NeverDeletes(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name   string
		output []byte
		err    error
	}{
		{"listing command failed", []byte("Error: connection reset"), errors.New("exit status 1")},
		{"human table instead of json", []byte("NAME            SIZE\n2026-07-01/     8.0K\n2026-07-02/     8.0K\n"), nil},
		{"truncated json", []byte(`[{"path":"daily/2026-07-01/hich`), nil},
		{"empty output", nil, nil},
		{"valid json, unexpected shape", []byte(`{"error":"bucket not found","code":404}`), nil},
		{"valid json, no daily paths", []byte(`["latest/db/hichat.db","latest/uploads/a.png"]`), nil},
		{"dates present but not under daily/", []byte(`["backups/2026-07-01","backups/2026-07-02","2026-07-03"]`), nil},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			svc, fake := localBackupService(t, time.Date(2026, 7, 19, 12, 0, 0, 0, time.UTC), 1)
			fake.handler = func(_ context.Context, call fakeCall) ([]byte, error) {
				if call.name == "hf" && len(call.args) > 1 && call.args[1] == "list" {
					return tc.output, tc.err
				}
				return nil, nil
			}

			svc.pruneDailySnapshots(context.Background(), "2026-07-19")

			if removed := fake.hfArgvContaining("remove"); len(removed) != 0 {
				t.Fatalf("ambiguous listing must delete nothing, got: %v", removed)
			}
		})
	}
}

// TestPruneDaily_NeverTargetsLatest: a listing carrying hostile or
// malformed entries — a literal "latest", a path-traversal escape, an
// absolute URI into another bucket — must never steer a delete outside the
// daily/ prefix. Delete paths are rebuilt from a re-validated date, so
// nothing the listing says can propagate into the argv.
func TestPruneDaily_NeverTargetsLatest(t *testing.T) {
	t.Parallel()
	svc, fake := localBackupService(t, time.Date(2026, 7, 19, 12, 0, 0, 0, time.UTC), 1)

	poisoned := `[
		"daily/2026-07-01/hichat.db",
		"daily/2026-07-02/hichat.db",
		"daily/2026-07-03/hichat.db",
		"daily/latest",
		"daily/latest/db/hichat.db",
		"latest/db/hichat.db",
		"daily/2026-07-04/../../latest",
		"daily/../latest/db/hichat.db",
		"hf://buckets/someone-else/latest/db/hichat.db",
		"daily/2026-13-45",
		"daily/../../../etc/passwd"
	]`
	fake.handler = func(_ context.Context, call fakeCall) ([]byte, error) {
		if call.name == "hf" && len(call.args) > 1 && call.args[1] == "list" {
			return []byte(poisoned), nil
		}
		return nil, nil
	}

	svc.pruneDailySnapshots(context.Background(), "2026-07-19")

	removed := fake.hfArgvContaining("buckets remove")
	if len(removed) == 0 {
		t.Fatal("expected the legitimate dated prefixes to still be prunable")
	}
	const wantPrefix = "hf://buckets/test/bucket/daily/"
	for _, argv := range removed {
		if strings.Contains(argv, "latest") {
			t.Fatalf("prune must NEVER target latest/, got: %s", argv)
		}
		if strings.Contains(argv, "..") {
			t.Fatalf("prune must never emit a traversal path, got: %s", argv)
		}
		if strings.Contains(argv, "someone-else") {
			t.Fatalf("prune must never leave the configured bucket, got: %s", argv)
		}
		if !strings.Contains(argv, wantPrefix) {
			t.Fatalf("prune target outside %s: %s", wantPrefix, argv)
		}
	}
}

// TestRemoveDailySnapshot_RejectsNonDate pins the last-line guard directly:
// even called with a hostile "date", removeDailySnapshot must error out
// before invoking the CLI at all.
func TestRemoveDailySnapshot_RejectsNonDate(t *testing.T) {
	t.Parallel()
	for _, bad := range []string{
		"latest",
		"",
		"..",
		"../latest",
		"2026-07-19/../../latest",
		"2026-13-45", // well-shaped but not a real date
		"2026-02-30",
		"*",
	} {
		t.Run(bad, func(t *testing.T) {
			t.Parallel()
			svc, fake := localBackupService(t, time.Date(2026, 7, 19, 12, 0, 0, 0, time.UTC), 7)

			if err := svc.removeDailySnapshot(context.Background(), bad); err == nil {
				t.Fatalf("removeDailySnapshot(%q) = nil, want refusal", bad)
			}
			if len(fake.calls) != 0 {
				t.Fatalf("a refused delete must not reach the CLI, got %v", fake.calls)
			}
		})
	}
}

// ── Goroutine lifecycle ──

// TestStop_CancelsUploadsRestore: the async uploads restore used to run on
// its own detached 60-minute context, so a shutdown left a multi-GB
// download running against a process trying to exit. It now descends from
// svcCtx, and Stop() must tear it down promptly.
func TestStop_CancelsUploadsRestore(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	dbPath := filepath.Join(root, "hichat.db")
	// Non-empty DB → warm-boot path: no download, but the uploads restore
	// still fires (that's the goroutine under test).
	if err := os.WriteFile(dbPath, make([]byte, 8192), 0o640); err != nil {
		t.Fatalf("seed DB: %v", err)
	}

	svc, fake := newTestBackupService(t, config.BackupConfig{
		Enabled:   true,
		HFToken:   "fake-token",
		HFBucket:  "test/bucket",
		DBPath:    dbPath,
		UploadDir: filepath.Join(root, "uploads"), // missing → restore proceeds
	})

	var once sync.Once
	started := make(chan struct{})
	// Model a long-running transfer: block until the context is cancelled.
	// If Stop() doesn't reach this context, the test hits its timeout.
	fake.handler = func(ctx context.Context, _ fakeCall) ([]byte, error) {
		once.Do(func() { close(started) })
		<-ctx.Done()
		return nil, ctx.Err()
	}

	if err := svc.Restore(context.Background()); err != nil {
		t.Fatalf("Restore err = %v, want nil", err)
	}

	select {
	case <-started:
	case <-time.After(10 * time.Second):
		t.Fatal("uploads restore never started")
	}

	svc.Stop()

	done := make(chan struct{})
	go func() {
		svc.waitForUploadsRestore()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("Stop() did not cancel the in-flight uploads restore (goroutine still detached)")
	}
}

// TestStop_Idempotent: Stop is called from both Shutdown and the signal
// path, so a double call must not panic on the cancel func or the channel.
func TestStop_Idempotent(t *testing.T) {
	t.Parallel()
	svc, _ := newTestBackupService(t, config.BackupConfig{
		Enabled: false,
		DBPath:  filepath.Join(t.TempDir(), "hichat.db"),
	})
	svc.Stop()
	svc.Stop()
	svc.Shutdown(context.Background())
}
