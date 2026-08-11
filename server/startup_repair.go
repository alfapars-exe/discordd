package main

// Boot-time startup hooks: corrupt-ID repair, stale presence reset, and platform admin/LiveKit seeding.

import (
	"context"
	"fmt"
	"log"
	"strconv"
	"time"

	"github.com/argeinfina/hichat/config"
	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/crypto"
	"github.com/argeinfina/hichat/pkg/logx"
)

// startupLogger tags every boot-time repair/seed log line originating from
// this file (corrupt-ID cleanup, stale presence reset, platform LiveKit
// seeding, platform admin bootstrap).
var startupLogger = logx.Component("startup")

// bootstrapPlatformAdmin idempotently grants platform-admin to a known
// username at every server start. Required because the in-app admin endpoint
// (PATCH /api/admin/users/{id}/platform-admin) is auth-gated by the same
// privilege it grants — without a server-side bootstrap there's no way to
// promote the very first admin without manual DB access.
//
// H-07 fix: the UPDATE only fires while the platform has zero admins
// (`AND NOT EXISTS (SELECT 1 FROM users WHERE is_platform_admin = 1)`). The
// moment any admin exists — whether created by this bootstrap or via the
// in-app endpoint above — the statement becomes a permanent no-op. The
// existence of the first admin IS the one-time-bootstrap marker, so no extra
// table is needed. This also closes the username-reuse vector: usernames are
// mutable (models.UpdateProfileRequest.Username), so if the configured admin
// later renames themselves and someone else claims the freed username, that
// person can no longer be promoted on the next boot — an admin already
// exists by then. `is_bot = 0` is defense in depth: bot accounts are
// user-created (072_bot_accounts.sql) and a bot row that happens to carry
// the configured username must not be able to grab the privilege.
//
// Residual risk this does NOT close: on a genuinely fresh install (zero
// admins yet, e.g. right after first deploy) an attacker who registers the
// configured username before the real operator does still gets promoted on
// the next boot. That's inherent to bootstrapping-by-username, not something
// a single UPDATE predicate can rule out. Because a normal first-time
// bootstrap and this attack look identical to the query, every promotion is
// logged at Warn (not Info) with the promoted account's id and created_at,
// so an operator who wasn't expecting a promotion has a signal to check.
func bootstrapPlatformAdmin(db *database.DB, username string) {
	if username == "" {
		return
	}
	ctx := context.Background()
	res, err := db.Conn.ExecContext(ctx,
		`UPDATE users SET is_platform_admin = 1
		 WHERE username = ?
		   AND is_platform_admin = 0
		   AND is_bot = 0
		   AND NOT EXISTS (SELECT 1 FROM users WHERE is_platform_admin = 1)`,
		username,
	)
	if err != nil {
		// username is operator-configured but reaches the log via a
		// structured attr; strconv.Quote still wraps it so a username
		// containing control characters can't forge/split log lines (G706).
		startupLogger.Error("bootstrap platform admin failed", "username", strconv.Quote(username), "err", pkg.ErrText(err))
		return
	}
	affected, _ := res.RowsAffected()
	if affected == 0 {
		return
	}

	// Best-effort read-back of the promoted row's id/created_at for the
	// warning below. RETURNING is deliberately avoided here for Turso/Hrana
	// safety (same reasoning as sqlite_role.go/sqlite_user.go Create) — a
	// failed read-back still logs the promotion, just without the extra
	// detail.
	var id string
	var createdAt time.Time
	if scanErr := db.Conn.QueryRowContext(ctx,
		`SELECT id, created_at FROM users WHERE username = ? AND is_platform_admin = 1`,
		username,
	).Scan(&id, &createdAt); scanErr != nil {
		startupLogger.Warn("bootstrapped platform admin (id/created_at lookup failed)",
			"username", strconv.Quote(username), "err", pkg.ErrText(scanErr))
		return
	}
	startupLogger.Warn("bootstrapped platform admin",
		"username", strconv.Quote(username),
		"user_id", strconv.Quote(id),
		"created_at", createdAt,
	)
}

// repairCorruptIDs fixes empty-string ID rows left by an old bug. The
// invariant "every row has a non-empty ID" is enforced by the application
// today, but historical rows from earlier code paths may still violate it.
// Best-effort: every step logs and continues on error.
func repairCorruptIDs(db *database.DB) {
	ctx := context.Background()

	// LiveKit instances: rename empty-ID rows to a fresh hex id and rewrite
	// the foreign key on `servers` to match.
	var emptyLK int
	if err := db.Conn.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM livekit_instances WHERE id = ''`).Scan(&emptyLK); err != nil {
		startupLogger.Error("failed to check empty-ID livekit instances", "err", pkg.ErrText(err))
	}
	if emptyLK > 0 {
		var newLKID string
		if err := db.Conn.QueryRowContext(ctx,
			`SELECT lower(hex(randomblob(8)))`).Scan(&newLKID); err != nil {
			startupLogger.Error("failed to generate new livekit ID", "err", pkg.ErrText(err))
		} else {
			if _, err := db.Conn.ExecContext(ctx,
				`UPDATE livekit_instances SET id = ? WHERE id = ''`, newLKID); err != nil {
				startupLogger.Error("failed to update empty-ID livekit instance", "err", pkg.ErrText(err))
			}
			res, fixErr := db.Conn.ExecContext(ctx,
				`UPDATE servers SET livekit_instance_id = ? WHERE livekit_instance_id = ''`, newLKID)
			if fixErr != nil {
				startupLogger.Error("failed to update server livekit refs", "err", pkg.ErrText(fixErr))
			} else if aff, _ := res.RowsAffected(); aff > 0 {
				startupLogger.Info("fixed empty-ID livekit instance", "new_livekit_id", newLKID, "server_refs_updated", aff)
			}
		}
	}

	// Servers with empty IDs are unreachable — drop their cascade rows
	// from related tables, then the server row itself.
	var emptySrv int
	if err := db.Conn.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM servers WHERE id = ''`).Scan(&emptySrv); err != nil {
		startupLogger.Error("failed to check empty-ID servers", "err", pkg.ErrText(err))
	}
	if emptySrv > 0 {
		cleanupTables := []string{"channels", "categories", "roles", "user_roles", "invites", "bans", "server_members"}
		for _, table := range cleanupTables {
			if _, err := db.Conn.ExecContext(ctx,
				fmt.Sprintf(`DELETE FROM %s WHERE server_id = ''`, table)); err != nil {
				startupLogger.Error("failed to clean empty-ID rows", "table", table, "err", pkg.ErrText(err))
			}
		}
		if _, err := db.Conn.ExecContext(ctx, `DELETE FROM servers WHERE id = ''`); err != nil {
			startupLogger.Error("failed to delete empty-ID servers", "err", pkg.ErrText(err))
		}
		startupLogger.Info("cleaned up empty-ID server(s) and related data", "count", emptySrv)
	}
}

// repairOrphanedServerData purges rows left behind by past server deletions
// that predate the transactional cascade delete (see
// repository.deleteServerCascade / sqliteServerRepo.Delete). Those old
// deletions only removed the servers row, so channels/categories/roles/
// invites/user_roles/bans — and everything under channels/roles — could be
// stranded with no owning server. New deletions no longer produce these;
// this is a one-time backfill for damage that already happened.
//
// Deepest-first, same ordering and same reasoning as the live cascade: don't
// assume ON DELETE CASCADE fires reliably on the remote libSQL/Turso
// connection this database runs on (see deleteServerCascade's comment).
// Every predicate is `NOT EXISTS (SELECT 1 FROM servers ...)`, so once a
// server's rows are gone the corresponding statement matches nothing —
// idempotent, safe to run on every boot, and silent when the database is
// already clean (only tables actually purged get a log line).
func repairOrphanedServerData(db *database.DB) {
	ctx := context.Background()

	stmts := []struct {
		table string
		query string
	}{
		{"attachments", `DELETE FROM attachments WHERE message_id IN (
			SELECT id FROM messages WHERE channel_id IN (
				SELECT id FROM channels c WHERE NOT EXISTS (
					SELECT 1 FROM servers s WHERE s.id = c.server_id)))`},
		{"reactions", `DELETE FROM reactions WHERE message_id IN (
			SELECT id FROM messages WHERE channel_id IN (
				SELECT id FROM channels c WHERE NOT EXISTS (
					SELECT 1 FROM servers s WHERE s.id = c.server_id)))`},
		{"message_mentions", `DELETE FROM message_mentions WHERE message_id IN (
			SELECT id FROM messages WHERE channel_id IN (
				SELECT id FROM channels c WHERE NOT EXISTS (
					SELECT 1 FROM servers s WHERE s.id = c.server_id)))`},
		{"message_role_mentions", `DELETE FROM message_role_mentions
			WHERE message_id IN (
				SELECT id FROM messages WHERE channel_id IN (
					SELECT id FROM channels c WHERE NOT EXISTS (
						SELECT 1 FROM servers s WHERE s.id = c.server_id)))
			   OR role_id IN (
				SELECT id FROM roles r WHERE NOT EXISTS (
					SELECT 1 FROM servers s WHERE s.id = r.server_id))`},
		{"pinned_messages", `DELETE FROM pinned_messages WHERE channel_id IN (
			SELECT id FROM channels c WHERE NOT EXISTS (
				SELECT 1 FROM servers s WHERE s.id = c.server_id))`},
		{"messages", `DELETE FROM messages WHERE channel_id IN (
			SELECT id FROM channels c WHERE NOT EXISTS (
				SELECT 1 FROM servers s WHERE s.id = c.server_id))`},
		{"channel_permissions", `DELETE FROM channel_permissions
			WHERE channel_id IN (
				SELECT id FROM channels c WHERE NOT EXISTS (
					SELECT 1 FROM servers s WHERE s.id = c.server_id))
			   OR role_id IN (
				SELECT id FROM roles r WHERE NOT EXISTS (
					SELECT 1 FROM servers s WHERE s.id = r.server_id))`},
		{"channel_reads", `DELETE FROM channel_reads WHERE channel_id IN (
			SELECT id FROM channels c WHERE NOT EXISTS (
				SELECT 1 FROM servers s WHERE s.id = c.server_id))`},
		{"channel_group_sessions", `DELETE FROM channel_group_sessions WHERE channel_id IN (
			SELECT id FROM channels c WHERE NOT EXISTS (
				SELECT 1 FROM servers s WHERE s.id = c.server_id))`},
		// channel_sender_key_envelopes (migration 075, pentest C-03) --
		// same orphan shape as channel_group_sessions above, same reason it
		// needs an explicit repair statement rather than trusting its
		// declared ON DELETE CASCADE (see repository/server_cascade.go).
		{"channel_sender_key_envelopes", `DELETE FROM channel_sender_key_envelopes WHERE channel_id IN (
			SELECT id FROM channels c WHERE NOT EXISTS (
				SELECT 1 FROM servers s WHERE s.id = c.server_id))`},
		// The DELETE target itself is referenced by its real table name, not
		// an alias — this SQLite build rejects `DELETE FROM table alias`.
		{"channels", `DELETE FROM channels WHERE NOT EXISTS (
			SELECT 1 FROM servers s WHERE s.id = channels.server_id)`},
		{"user_roles", `DELETE FROM user_roles WHERE NOT EXISTS (
			SELECT 1 FROM servers s WHERE s.id = user_roles.server_id)`},
		{"roles", `DELETE FROM roles WHERE NOT EXISTS (
			SELECT 1 FROM servers s WHERE s.id = roles.server_id)`},
		{"categories", `DELETE FROM categories WHERE NOT EXISTS (
			SELECT 1 FROM servers s WHERE s.id = categories.server_id)`},
		{"invites", `DELETE FROM invites WHERE NOT EXISTS (
			SELECT 1 FROM servers s WHERE s.id = invites.server_id)`},
		{"bans", `DELETE FROM bans WHERE NOT EXISTS (
			SELECT 1 FROM servers s WHERE s.id = bans.server_id)`},
	}

	var totalRows int64
	for _, stmt := range stmts {
		result, err := db.Conn.ExecContext(ctx, stmt.query)
		if err != nil {
			log.Printf("[main] warning: orphaned-server-data repair failed on %s: %v", stmt.table, err)
			continue
		}
		affected, err := result.RowsAffected()
		if err != nil {
			log.Printf("[main] warning: failed to check rows affected repairing %s: %v", stmt.table, err)
			continue
		}
		if affected > 0 {
			log.Printf("[main] repaired %d orphaned row(s) in %s (deleted server, pre-cascade-fix)", affected, stmt.table)
			totalRows += affected
		}
	}
	if totalRows > 0 {
		log.Printf("[main] orphaned-server-data repair complete: %d row(s) removed", totalRows)
	}
}

// resetStalePresence flips any user marked as online/idle back to offline.
// Required because the WebSocket disconnect handler is the source of truth
// for presence transitions, and it doesn't run if the process was killed.
// Callers' first WS connect after this will set them online again normally.
func resetStalePresence(db *database.DB) {
	result, err := db.Conn.ExecContext(context.Background(),
		`UPDATE users SET status = 'offline', last_seen_at = CURRENT_TIMESTAMP WHERE status IN ('online', 'idle')`)
	if err != nil {
		startupLogger.Error("failed to reset stale presence", "err", pkg.ErrText(err))
		return
	}
	if affected, _ := result.RowsAffected(); affected > 0 {
		startupLogger.Info("reset stale user status(es) to offline", "count", affected)
	}
}

// seedPlatformLiveKit ensures a platform-managed LiveKit instance exists in
// the DB whenever the LIVEKIT_URL/KEY/SECRET env triplet is configured. The
// API key and secret are AES-encrypted with the project encryption key
// before insertion. If the instance already exists, we just back-fill any
// servers whose livekit_instance_id is NULL so they pick up the platform
// SFU on next voice connect.
func seedPlatformLiveKit(db *database.DB, repos *Repositories, cfg *config.Config, encryptionKey []byte) {
	if cfg.LiveKit.URL == "" || cfg.LiveKit.APIKey == "" || cfg.LiveKit.APISecret == "" {
		return
	}
	ctx := context.Background()

	platformInstance, seedErr := repos.LiveKit.GetLeastLoadedPlatformInstance(ctx)
	if seedErr != nil {
		encKey, encErr := crypto.Encrypt(cfg.LiveKit.APIKey, encryptionKey)
		if encErr != nil {
			log.Fatalf("[main] failed to encrypt platform livekit key: %v", encErr)
		}
		encSecret, encErr := crypto.Encrypt(cfg.LiveKit.APISecret, encryptionKey)
		if encErr != nil {
			log.Fatalf("[main] failed to encrypt platform livekit secret: %v", encErr)
		}

		platformInstance = &models.LiveKitInstance{
			URL:               cfg.LiveKit.URL,
			APIKey:            encKey,
			APISecret:         encSecret,
			IsPlatformManaged: true,
			ServerCount:       0,
		}
		if createErr := repos.LiveKit.Create(ctx, platformInstance); createErr != nil {
			log.Fatalf("[main] failed to seed platform livekit instance: %v", createErr)
		}
		startupLogger.Info("seeded platform LiveKit instance", "url", cfg.LiveKit.URL, "livekit_instance_id", platformInstance.ID)
	} else {
		// Instance already exists. Keep its stored (encrypted) credentials in
		// sync with the env triplet so rotating LIVEKIT_URL/KEY/SECRET and
		// restarting actually updates the key the voice-token signer uses.
		// Without this, the DB keeps the original seed credentials forever and
		// an env rotation silently has no effect (the 2026-05-27 voice outage).
		changed := false
		if platformInstance.URL != cfg.LiveKit.URL {
			platformInstance.URL = cfg.LiveKit.URL
			changed = true
		}
		if cur, err := crypto.Decrypt(platformInstance.APIKey, encryptionKey); err != nil || cur != cfg.LiveKit.APIKey {
			if enc, encErr := crypto.Encrypt(cfg.LiveKit.APIKey, encryptionKey); encErr != nil {
				startupLogger.Error("failed to encrypt rotated platform livekit key", "err", pkg.ErrText(encErr))
			} else {
				platformInstance.APIKey = enc
				changed = true
			}
		}
		if cur, err := crypto.Decrypt(platformInstance.APISecret, encryptionKey); err != nil || cur != cfg.LiveKit.APISecret {
			if enc, encErr := crypto.Encrypt(cfg.LiveKit.APISecret, encryptionKey); encErr != nil {
				startupLogger.Error("failed to encrypt rotated platform livekit secret", "err", pkg.ErrText(encErr))
			} else {
				platformInstance.APISecret = enc
				changed = true
			}
		}
		if changed {
			if updErr := repos.LiveKit.Update(ctx, platformInstance); updErr != nil {
				startupLogger.Error("failed to sync platform livekit credentials from env", "err", pkg.ErrText(updErr))
			} else {
				startupLogger.Info("synced platform LiveKit credentials from env", "livekit_instance_id", platformInstance.ID)
			}
		}
	}

	result, linkErr := db.Conn.ExecContext(ctx,
		`UPDATE servers SET livekit_instance_id = ? WHERE livekit_instance_id IS NULL`,
		platformInstance.ID,
	)
	if linkErr != nil {
		startupLogger.Error("failed to link orphan servers to platform livekit", "err", pkg.ErrText(linkErr))
	} else if affected, _ := result.RowsAffected(); affected > 0 {
		startupLogger.Info("linked orphan server(s) to platform LiveKit instance", "count", affected)
	}
}
