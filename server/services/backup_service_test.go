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
	// taken from the args (e.g. the restore staging path).
	handler func(call fakeCall) ([]byte, error)
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

func (f *fakeRunner) run(_ context.Context, env []string, name string, args ...string) ([]byte, error) {
	f.mu.Lock()
	f.calls = append(f.calls, fakeCall{name: name, args: append([]string(nil), args...), env: env})
	f.mu.Unlock()
	if f.handler != nil {
		return f.handler(fakeCall{name: name, args: args, env: env})
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
	fake.handler = func(call fakeCall) ([]byte, error) {
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

	fake.handler = func(call fakeCall) ([]byte, error) {
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

	fake.handler = func(call fakeCall) ([]byte, error) {
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

	// The faked `sqlite3 VACUUM INTO '<snap>'` must actually create the
	// snapshot file so the os.Stat gate lets the DB upload proceed.
	fake.handler = func(call fakeCall) ([]byte, error) {
		if call.name == "sqlite3" && len(call.args) > 0 {
			stmt := call.args[len(call.args)-1]
			if i := strings.Index(stmt, "'"); i >= 0 {
				if j := strings.LastIndex(stmt, "'"); j > i {
					_ = os.WriteFile(stmt[i+1:j], make([]byte, 8192), 0o640)
				}
			}
		}
		return nil, nil
	}

	svc.Shutdown(context.Background())

	if got := fake.callsTo("sqlite3"); got != 1 {
		t.Fatalf("shutdown must take exactly one VACUUM snapshot, got %d sqlite3 call(s)", got)
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
