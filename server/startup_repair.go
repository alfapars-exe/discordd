package main

// Boot-time startup hooks: corrupt-ID repair, stale presence reset, and platform admin/LiveKit seeding.

import (
	"context"
	"fmt"
	"log"

	"github.com/argeinfina/hichat/config"
	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg/crypto"
)

// bootstrapPlatformAdmin idempotently grants platform-admin to a known
// username at every server start. Required because the in-app admin endpoint
// (PATCH /api/admin/users/{id}/platform-admin) is auth-gated by the same
// privilege it grants — without a server-side bootstrap there's no way to
// promote the very first admin without manual DB access.
//
// Safe to leave in place: the UPDATE is a no-op once the user is already an
// admin, and ignores users who don't exist yet (e.g. before they register).
func bootstrapPlatformAdmin(db *database.DB, username string) {
	if username == "" {
		return
	}
	res, err := db.Conn.ExecContext(context.Background(),
		`UPDATE users SET is_platform_admin = 1 WHERE username = ? AND is_platform_admin = 0`,
		username,
	)
	if err != nil {
		log.Printf("[main] bootstrap platform admin (%s) failed: %v", username, err)
		return
	}
	if affected, _ := res.RowsAffected(); affected > 0 {
		log.Printf("[main] bootstrapped platform admin: %s", username)
	}
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
		log.Printf("[main] warning: failed to check empty-ID livekit instances: %v", err)
	}
	if emptyLK > 0 {
		var newLKID string
		if err := db.Conn.QueryRowContext(ctx,
			`SELECT lower(hex(randomblob(8)))`).Scan(&newLKID); err != nil {
			log.Printf("[main] warning: failed to generate new livekit ID: %v", err)
		} else {
			if _, err := db.Conn.ExecContext(ctx,
				`UPDATE livekit_instances SET id = ? WHERE id = ''`, newLKID); err != nil {
				log.Printf("[main] warning: failed to update empty-ID livekit instance: %v", err)
			}
			res, fixErr := db.Conn.ExecContext(ctx,
				`UPDATE servers SET livekit_instance_id = ? WHERE livekit_instance_id = ''`, newLKID)
			if fixErr != nil {
				log.Printf("[main] warning: failed to update server livekit refs: %v", fixErr)
			} else if aff, _ := res.RowsAffected(); aff > 0 {
				log.Printf("[main] fixed empty-ID livekit instance → %s (%d server refs updated)", newLKID, aff)
			}
		}
	}

	// Servers with empty IDs are unreachable — drop their cascade rows
	// from related tables, then the server row itself.
	var emptySrv int
	if err := db.Conn.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM servers WHERE id = ''`).Scan(&emptySrv); err != nil {
		log.Printf("[main] warning: failed to check empty-ID servers: %v", err)
	}
	if emptySrv > 0 {
		cleanupTables := []string{"channels", "categories", "roles", "user_roles", "invites", "bans", "server_members"}
		for _, table := range cleanupTables {
			if _, err := db.Conn.ExecContext(ctx,
				fmt.Sprintf(`DELETE FROM %s WHERE server_id = ''`, table)); err != nil {
				log.Printf("[main] warning: failed to clean empty-ID from %s: %v", table, err)
			}
		}
		if _, err := db.Conn.ExecContext(ctx, `DELETE FROM servers WHERE id = ''`); err != nil {
			log.Printf("[main] warning: failed to delete empty-ID servers: %v", err)
		}
		log.Printf("[main] cleaned up %d empty-ID server(s) and related data", emptySrv)
	}
}

// resetStalePresence flips any user marked as online/idle back to offline.
// Required because the WebSocket disconnect handler is the source of truth
// for presence transitions, and it doesn't run if the process was killed.
// Callers' first WS connect after this will set them online again normally.
func resetStalePresence(db *database.DB) {
	result, err := db.Conn.ExecContext(context.Background(),
		`UPDATE users SET status = 'offline' WHERE status IN ('online', 'idle')`)
	if err != nil {
		log.Printf("[main] warning: failed to reset stale presence: %v", err)
		return
	}
	if affected, _ := result.RowsAffected(); affected > 0 {
		log.Printf("[main] reset %d stale user status(es) to offline", affected)
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
		log.Printf("[main] seeded platform LiveKit instance (url=%s, id=%s)", cfg.LiveKit.URL, platformInstance.ID)
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
				log.Printf("[main] warning: failed to encrypt rotated platform livekit key: %v", encErr)
			} else {
				platformInstance.APIKey = enc
				changed = true
			}
		}
		if cur, err := crypto.Decrypt(platformInstance.APISecret, encryptionKey); err != nil || cur != cfg.LiveKit.APISecret {
			if enc, encErr := crypto.Encrypt(cfg.LiveKit.APISecret, encryptionKey); encErr != nil {
				log.Printf("[main] warning: failed to encrypt rotated platform livekit secret: %v", encErr)
			} else {
				platformInstance.APISecret = enc
				changed = true
			}
		}
		if changed {
			if updErr := repos.LiveKit.Update(ctx, platformInstance); updErr != nil {
				log.Printf("[main] warning: failed to sync platform livekit credentials from env: %v", updErr)
			} else {
				log.Printf("[main] synced platform LiveKit credentials from env (id=%s)", platformInstance.ID)
			}
		}
	}

	result, linkErr := db.Conn.ExecContext(ctx,
		`UPDATE servers SET livekit_instance_id = ? WHERE livekit_instance_id IS NULL`,
		platformInstance.ID,
	)
	if linkErr != nil {
		log.Printf("[main] warning: failed to link orphan servers to platform livekit: %v", linkErr)
	} else if affected, _ := result.RowsAffected(); affected > 0 {
		log.Printf("[main] linked %d orphan server(s) to platform LiveKit instance", affected)
	}
}
