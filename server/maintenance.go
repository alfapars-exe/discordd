package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/repository"
)

// linkPreviewRetention is how long link-preview cache rows are kept. The
// read path treats rows older than 24h as stale (re-fetches), so anything
// past a week is pure dead weight.
const linkPreviewRetention = 7 * 24 * time.Hour

// orphanReport is one table's worth of census result. Only non-zero counts
// are ever reported.
type orphanReport struct {
	table  string
	detail string
	rows   int64
}

// orphanChecks are read-only integrity probes, one per table.
//
// Why these tables: 018_multi_server.sql added `server_id` to channels,
// invites, categories and user_roles with plain `TEXT DEFAULT 'default'` —
// SQLite cannot combine REFERENCES with DEFAULT in ALTER TABLE ADD COLUMN, so
// those relationships are conventions the database does not enforce. The
// remaining two (user_roles -> users/roles, attachments -> messages) DO have
// declared foreign keys, which makes them the useful control: if rows ever
// show up there, enforcement is not doing what we assume — which is the same
// question ProbeForeignKeys asks at boot, answered from the data side.
//
// One row per table, not per broken parent: a user_roles row whose user, role
// and server are all missing is a single orphaned row.
//
// These are COUNT queries over whole tables. They run hourly, off the request
// path, inside the sweeper's existing one-minute bounded context.
var orphanChecks = []struct {
	table  string
	detail string
	query  string
}{
	{
		table:  "user_roles",
		detail: "missing user, role or server",
		query: `SELECT COUNT(*) FROM user_roles ur
			WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = ur.user_id)
			   OR NOT EXISTS (SELECT 1 FROM roles r WHERE r.id = ur.role_id)
			   OR NOT EXISTS (SELECT 1 FROM servers s WHERE s.id = ur.server_id)`,
	},
	{
		table:  "channels",
		detail: "missing server",
		query: `SELECT COUNT(*) FROM channels c
			WHERE NOT EXISTS (SELECT 1 FROM servers s WHERE s.id = c.server_id)`,
	},
	{
		table:  "invites",
		detail: "missing server",
		query: `SELECT COUNT(*) FROM invites i
			WHERE NOT EXISTS (SELECT 1 FROM servers s WHERE s.id = i.server_id)`,
	},
	{
		table:  "categories",
		detail: "missing server",
		query: `SELECT COUNT(*) FROM categories c
			WHERE NOT EXISTS (SELECT 1 FROM servers s WHERE s.id = c.server_id)`,
	},
	{
		table:  "attachments",
		detail: "missing message",
		query: `SELECT COUNT(*) FROM attachments a
			WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = a.message_id)`,
	},
}

// censusOrphans counts rows whose parent is gone, returning only the tables
// with a non-zero count.
//
// Strictly read-only, and deliberately so: deleting orphans is a per-table
// judgement call about what the rows mean, not something a background sweeper
// should decide. Migration 055 cleaned up orphaned user_roles rows only after
// establishing why they existed and what dropping them would change.
//
// A failing query is collected as an error rather than swallowed — reporting
// "no orphans" because the count blew up would be worse than reporting
// nothing at all. Remaining checks still run, so one broken table does not
// blind the rest.
func censusOrphans(ctx context.Context, conn *sql.DB) ([]orphanReport, error) {
	if conn == nil {
		return nil, errors.New("orphan census: nil database connection")
	}
	var (
		reports []orphanReport
		errs    []error
	)
	for _, check := range orphanChecks {
		var rows int64
		if err := conn.QueryRowContext(ctx, check.query).Scan(&rows); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", check.table, err))
			continue
		}
		if rows > 0 {
			reports = append(reports, orphanReport{
				table:  check.table,
				detail: check.detail,
				rows:   rows,
			})
		}
	}
	return reports, errors.Join(errs...)
}

// startMaintenanceSweeper purges time-expired rows that previously had no
// caller (audit P1-BD-04): expired sessions and stale link-preview cache
// entries accumulated forever. Sweeps once at boot, then every interval.
// Errors are logged, never fatal. Returns a stop func for graceful shutdown
// (mirrors startRuntimeStatsLogger).
//
// The same pass also runs a read-only orphan census (censusOrphans) so
// referential drift shows up in the logs instead of going unnoticed. `conn`
// may be nil, which skips the census — the purges still run.
func startMaintenanceSweeper(
	sessions repository.SessionRepository,
	previews repository.LinkPreviewRepository,
	conn *sql.DB,
	interval time.Duration,
) func() {
	stop := make(chan struct{})
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		logger := logx.Component("maintenance")

		sweep := func() {
			ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
			defer cancel()
			if err := sessions.DeleteExpired(ctx); err != nil {
				logger.Error("expired session sweep failed", "error", err)
			}
			deleted, err := previews.DeleteExpired(ctx, time.Now().Add(-linkPreviewRetention))
			if err != nil {
				logger.Error("link preview sweep failed", "error", err)
			} else if deleted > 0 {
				logger.Info("link preview sweep", "deleted_rows", deleted)
			}

			// Read-only integrity census. Reuses the bounded ctx above.
			// Silent when everything is consistent — a clean database logs
			// nothing here, so any line below is a real signal.
			if conn != nil {
				reports, err := censusOrphans(ctx, conn)
				if err != nil {
					logger.Error("orphan census failed", "error", err)
				}
				for _, r := range reports {
					logger.Warn("orphaned rows detected",
						"table", r.table,
						"orphan_rows", r.rows,
						"reason", r.detail)
				}
			}
		}

		sweep()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				sweep()
			}
		}
	}()
	return func() { close(stop) }
}
