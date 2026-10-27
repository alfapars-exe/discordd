package repository

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

// The blocker is observed in PostgreSQL rather than inferred from a sleep.
func waitGroupEditBlocked(t *testing.T, ctx context.Context, query interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, blocker int) {
	t.Helper()
	for {
		var blocked bool
		if err := query.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND ? = ANY(pg_blocking_pids(pid)))`, blocker).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal("operation did not reach PostgreSQL lock wait")
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func TestGroupDMPostgresEditMembershipRace(t *testing.T) {
	dsn := os.Getenv("HICHAT_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("HICHAT_TEST_POSTGRES_DSN is not configured")
	}
	for _, removed := range []bool{false, true} {
		name := "remaining author after rekey"
		if removed {
			name = "removed author"
		}
		t.Run(name, func(t *testing.T) {
			db, _ := newPostgresTestDB(t, dsn)
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			if _, err := db.Conn.ExecContext(ctx, `INSERT INTO users(id,username,password_hash) VALUES('edit-owner','edit-owner','x'),('edit-member','edit-member','x')`); err != nil {
				t.Fatal(err)
			}
			repo := NewSQLiteGroupDMRepo(wrapForRepo(db))
			group := &models.GroupDM{ID: "edit-group", OwnerID: "edit-owner", Name: "Edit", KeyEpoch: 1, CallRoomKey: "edit-room"}
			if err := repo.Create(ctx, group, []string{"edit-owner", "edit-member"}); err != nil {
				t.Fatal(err)
			}
			author := "edit-owner"
			if removed {
				author = "edit-member"
			}
			original, device, edited := "original", "device", "edited"
			if err := repo.CreateMessage(ctx, &models.GroupDMMessage{ID: "edit-message", GroupID: group.ID, UserID: author, EncryptionVersion: 1, Ciphertext: &original, SenderDeviceID: &device, KeyEpoch: 1}); err != nil {
				t.Fatal(err)
			}
			change, err := db.Conn.BeginTx(ctx, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer change.Rollback()
			var pid int
			if err := change.QueryRowContext(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
				t.Fatal(err)
			}
			if err := lockGroupDM(ctx, change, group.ID); err != nil {
				t.Fatal(err)
			}
			// Hold precisely the lock used by changeMember while the edit starts.
			done := make(chan error, 1)
			go func() {
				done <- repo.UpdateMessage(ctx, group.ID, "edit-message", author, &models.UpdateGroupDMMessageRequest{Ciphertext: &edited, SenderDeviceID: &device, KeyEpoch: 1})
			}()
			waitGroupEditBlocked(t, ctx, db.Conn, pid)
			if _, err := change.ExecContext(ctx, `DELETE FROM group_dm_members WHERE group_id=? AND user_id=?`, group.ID, "edit-member"); err != nil {
				t.Fatal(err)
			}
			if _, err := change.ExecContext(ctx, `UPDATE group_dm_channels SET key_epoch=key_epoch+1 WHERE id=?`, group.ID); err != nil {
				t.Fatal(err)
			}
			if err := change.Commit(); err != nil {
				t.Fatal(err)
			}
			if err := <-done; !errors.Is(err, pkg.ErrConflict) {
				t.Fatalf("edit after membership commit: %v", err)
			}
			msg, err := repo.GetMessage(ctx, group.ID, "edit-message")
			if err != nil || msg.Ciphertext == nil || *msg.Ciphertext != original || msg.KeyEpoch != 1 || msg.EditedAt != nil {
				t.Fatalf("rejected edit changed message: %+v err=%v", msg, err)
			}
			err = repo.UpdateMessage(ctx, group.ID, "edit-message", author, &models.UpdateGroupDMMessageRequest{Ciphertext: &edited, SenderDeviceID: &device, KeyEpoch: 2})
			if removed {
				if !errors.Is(err, pkg.ErrConflict) {
					t.Fatalf("removed author with current epoch: %v", err)
				}
			} else if err != nil {
				t.Fatalf("remaining author with current epoch: %v", err)
			}
			if !removed {
				// Reverse the order: the edit owns the group lock and waits on
				// a message row, so the real membership repository must wait.
				rowLock, err := db.Conn.BeginTx(ctx, nil)
				if err != nil {
					t.Fatal(err)
				}
				defer rowLock.Rollback()
				var rowPID int
				if err := rowLock.QueryRowContext(ctx, `SELECT pg_backend_pid()`).Scan(&rowPID); err != nil {
					t.Fatal(err)
				}
				if _, err := rowLock.ExecContext(ctx, `UPDATE group_dm_messages SET ciphertext=ciphertext WHERE id=?`, "edit-message"); err != nil {
					t.Fatal(err)
				}
				go func() {
					done <- repo.UpdateMessage(ctx, group.ID, "edit-message", author, &models.UpdateGroupDMMessageRequest{Ciphertext: &edited, SenderDeviceID: &device, KeyEpoch: 2})
				}()
				waitGroupEditBlocked(t, ctx, db.Conn, rowPID)
				var editPID int
				if err := db.Conn.QueryRowContext(ctx, `SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND ? = ANY(pg_blocking_pids(pid))`, rowPID).Scan(&editPID); err != nil {
					t.Fatal(err)
				}
				membershipDone := make(chan error, 1)
				go func() { _, err := repo.RemoveMember(ctx, group.ID, author); membershipDone <- err }()
				waitGroupEditBlocked(t, ctx, db.Conn, editPID)
				if err := rowLock.Commit(); err != nil {
					t.Fatal(err)
				}
				if err := <-done; err != nil {
					t.Fatalf("edit holding group lock: %v", err)
				}
				if err := <-membershipDone; err != nil {
					t.Fatalf("membership after edit: %v", err)
				}
				msg, err := repo.GetMessage(ctx, group.ID, "edit-message")
				if err != nil || msg.Ciphertext == nil || *msg.Ciphertext != edited || msg.KeyEpoch != 2 || msg.EditedAt == nil {
					t.Fatalf("serialized edit missing: %+v err=%v", msg, err)
				}
			}
		})
	}
}
