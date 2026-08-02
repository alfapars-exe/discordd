// backup_service_util.go: shared helpers - subprocess runner, hf error sniffing, file and string utilities.
package services

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
)

func defaultRunCmd(ctx context.Context, env []string, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...) // #nosec G204 -- name is a runtime parameter only because this is the shared, testable indirection (see cmdRunner doc); at all 8 call sites in this file it is a fixed literal ("hf" or "sqlite3"), never a variable, and args come from internal config/generated paths, never raw request input. exec.CommandContext also never invokes a shell, so no metacharacter-injection vector exists regardless.
	if env != nil {
		cmd.Env = env
	}
	return cmd.CombinedOutput()
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
	defer func() { _ = in.Close() }() // read-side handle — nothing buffered to flush, safe to ignore

	// 0o600: snapshot copies carry the full DB — owner-only.
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}

	// Explicit close before any error path — a snapshot copy that silently
	// drops its trailing buffered write would report success while leaving
	// a truncated backup on disk.
	_, copyErr := io.Copy(out, in)
	syncErr := out.Sync()
	closeErr := out.Close()
	if copyErr != nil {
		_ = os.Remove(dst)
		return copyErr
	}
	if syncErr != nil {
		_ = os.Remove(dst)
		return syncErr
	}
	if closeErr != nil {
		_ = os.Remove(dst)
		return fmt.Errorf("failed to finalize copy of %s: %w", dst, closeErr)
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
		// Enable the hf_xet high-performance transfer path. huggingface_hub
		// 1.0 dropped the `[hf_transfer]` extra, so the old
		// HF_HUB_ENABLE_HF_TRANSFER=1 var is a silent no-op today (pip just
		// ignores the unknown extra and the CLI falls back to the slow path).
		// hf_xet ships as a transitive dependency in the image (amd64+arm64)
		// since hf_xet 1.26.0, so this flag actually takes effect.
		"HF_XET_HIGH_PERFORMANCE=1",
	)
	return env
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
