package repository

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

func TestDMPostgresPolicyWaitsForPreferenceUpdate(t *testing.T) {
	dsn := os.Getenv("HICHAT_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("HICHAT_TEST_POSTGRES_DSN is not configured")
	}
	for _, existing := range []bool{false, true} {
		name := "absent preferences"
		if existing {
			name = "existing preferences"
		}
		t.Run(name, func(t *testing.T) {
			db, _ := newPostgresTestDB(t, dsn)
			seedDMUsers(t, db)
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			if existing {
				if _, err := db.Conn.ExecContext(ctx, `INSERT INTO user_preferences(user_id,data) VALUES(?,'{}')`, dmBob); err != nil {
					t.Fatal(err)
				}
			}
			update, err := db.Conn.BeginTx(ctx, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer update.Rollback()
			var updaterPID int
			if err := update.QueryRowContext(ctx, `SELECT pg_backend_pid()`).Scan(&updaterPID); err != nil {
				t.Fatal(err)
			}
			if _, err := update.ExecContext(ctx, `INSERT INTO user_preferences(user_id,data) VALUES(?,'{}') ON CONFLICT(user_id) DO NOTHING`, dmBob); err != nil {
				t.Fatal(err)
			}
			if _, err := update.ExecContext(ctx, `UPDATE user_preferences SET data=? WHERE user_id=?`, `{"privacy":{"serverDMDefault":false}}`, dmBob); err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() {
				done <- NewDMMessageTxRunner(db.Conn).InTx(ctx, func(r *DMTxRepos) error {
					if err := r.LockPreferences(ctx, dmBob); err != nil {
						return err
					}
					prefs, err := r.Preferences.Get(ctx, dmBob)
					if err != nil {
						return err
					}
					if !strings.Contains(string(prefs.Data), `"serverDMDefault":false`) {
						return context.Canceled
					}
					return nil
				})
			}()
			for {
				select {
				case err := <-done:
					t.Fatalf("policy completed before updater committed: %v", err)
				default:
				}
				var blocked bool
				if err := db.Conn.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND ? = ANY(pg_blocking_pids(pid)))`, updaterPID).Scan(&blocked); err != nil {
					t.Fatal(err)
				}
				if blocked {
					break
				}
				select {
				case <-ctx.Done():
					t.Fatal("policy did not block on preference update")
				case <-time.After(10 * time.Millisecond):
				}
			}
			if err := update.Commit(); err != nil {
				t.Fatal(err)
			}
			if err := <-done; err != nil {
				t.Fatalf("policy failed to read committed preferences: %v", err)
			}
		})
	}
}
