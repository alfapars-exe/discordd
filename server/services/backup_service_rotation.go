// backup_service_rotation.go: dated daily/ snapshot rotation, pruning, and the uploads directory mirror.
package services

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/argeinfina/hichat/pkg"
)

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
