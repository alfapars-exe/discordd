// sqlitePinRepo against a real local SQLite database.
//
// REGRESSION GUARD (security scan 2026-07-31, finding N-09 follow-up):
// PinnedMessageWithDetails.Message.Author and .PinnedByUser moved from
// *models.User to *models.PublicUser, which requires status/custom_status/
// created_at, but scanPin's SELECT list never picked up pb.status at all
// (author's u.custom_status and u.created_at were also missing, and pb's
// custom_status/created_at were still missing after a first-pass fix added
// pb.status). A wrong column here serializes pinned_by_user.status as "" —
// a value outside the UserStatus enum the client and openapi contract
// declare — and the pin panel's author card shows a null custom status and
// a year-1 "member since" date.
//
// DB harness / fixtures: testdb_test.go.
package repository

import (
	"context"
	"testing"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

const (
	pinChannel = "chan-pin"
	pinAuthor  = "u-pin-author"
	pinPinner  = "u-pin-by"
)

// seedPinWorld seeds an author and a pinning user with distinct, non-default
// status/custom_status values so the PublicUser assertions below are
// value-checked, not vacuously true on a zero value or the schema's DEFAULT
// 'offline'.
func seedPinWorld(t *testing.T, db *database.DB) {
	t.Helper()
	execSeed(t, db, []seedStmt{
		{`INSERT INTO users (id, username, display_name, custom_status, status, password_hash) VALUES (?, ?, ?, ?, ?, 'x')`,
			[]any{pinAuthor, "pinauthor", "Pin Author", "brb", "online"}},
		{`INSERT INTO users (id, username, custom_status, status, password_hash) VALUES (?, ?, ?, ?, 'x')`,
			[]any{pinPinner, "pinner", "pinning now", "idle"}},
		{`INSERT INTO channels (id, name, type, server_id) VALUES (?, ?, 'text', 'srv-1')`,
			[]any{pinChannel, "genel"}},
	})
}

func TestPinRepo_GetByChannelID_PublicUserFields(t *testing.T) {
	db := newTestDB(t)
	seedPinWorld(t, db)

	msgRepo := NewSQLiteMessageRepo(db.Conn)
	pinRepo := NewSQLitePinRepo(db.Conn)
	ctx := context.Background()

	content := "pin me"
	msg := &models.Message{ChannelID: pinChannel, UserID: pinAuthor, Content: &content}
	if err := msgRepo.Create(ctx, msg); err != nil {
		t.Fatalf("Create message: %v", err)
	}

	pin := &models.PinnedMessage{MessageID: msg.ID, ChannelID: pinChannel, PinnedBy: pinPinner}
	if err := pinRepo.Pin(ctx, pin); err != nil {
		t.Fatalf("Pin: %v", err)
	}

	got, err := pinRepo.GetByChannelID(ctx, pinChannel)
	if err != nil {
		t.Fatalf("GetByChannelID: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("pins = %d, want 1", len(got))
	}
	p := got[0]

	// pb.status was missing from the SELECT entirely, so this used to
	// deserialize as the UserStatus zero value "".
	if p.PinnedByUser == nil {
		t.Fatal("pinned_by_user is nil")
	}
	if p.PinnedByUser.Status != models.UserStatusIdle {
		t.Errorf("pinned_by_user.status = %q, want %q", p.PinnedByUser.Status, models.UserStatusIdle)
	}

	// pb.custom_status and pb.created_at were missing from the SELECT too,
	// so pinned_by_user.created_at always serialized as the zero time
	// ("0001-01-01T00:00:00Z") regardless of the row's actual value.
	if p.PinnedByUser.CustomStatus == nil || *p.PinnedByUser.CustomStatus != "pinning now" {
		t.Errorf("pinned_by_user.custom_status = %v, want %q", p.PinnedByUser.CustomStatus, "pinning now")
	}
	if p.PinnedByUser.CreatedAt.IsZero() {
		t.Error("pinned_by_user.created_at is zero — pb.created_at was not selected")
	}

	// u.custom_status and u.created_at were also missing from the SELECT.
	if p.Message == nil || p.Message.Author == nil {
		t.Fatal("message or its author is nil")
	}
	if p.Message.Author.CustomStatus == nil || *p.Message.Author.CustomStatus != "brb" {
		t.Errorf("author.custom_status = %v, want %q", p.Message.Author.CustomStatus, "brb")
	}
	if p.Message.Author.CreatedAt.IsZero() {
		t.Error("author.created_at is zero — u.created_at was not selected")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION GUARD — scanPin could not tolerate a deleted user on either join.
//
// scanPin made only the two ids nullable (authorID, pinnedByID) while
// author.Username, author.Status and pinnedByUser.Username stayed plain
// strings. When a LEFT JOIN finds no user row EVERY joined column comes back
// NULL, so the scan died with
//
//	converting NULL to string is unsupported
//
// and because scanRows propagates the first row error, GetByChannelID
// returned an error for the ENTIRE channel's pin list rather than degrading
// to a nil author. The `if authorID.Valid` / `if pinnedByID.Valid` branches
// below the scan were dead code.
//
// This is the same defect sqlite_message.go and sqlite_dm_scan.go were fixed
// for (see TestMessageRepo_NilAuthorScan_KnownBug); sqlite_pin.go was missed
// in that sweep.
//
// Reachability: messages.user_id and pinned_messages.pinned_by are both
// `REFERENCES users(id) ON DELETE CASCADE`, so with foreign keys enforced a
// pin cannot outlive either user — which is why this never shows up locally.
// But database.New sets foreign_keys(1) only on the LOCAL SQLite DSN; the
// remote libSQL/Turso branch opens with no pragmas at all and the migration
// runner strips every PRAGMA because Turso rejects them (see
// database/integrity.go, which exists precisely to answer "are FKs enforced
// in production?"). Production runs on Turso, and the repo already ships an
// orphan census because dangling rows are a known production condition.
//
// execWithoutFKs plants the dangling row the same way production plausibly
// gets one: through a connection where enforcement was not in effect.
// ─────────────────────────────────────────────────────────────────────────────

func TestPinRepo_GetByChannelID_ToleratesDeletedUsers(t *testing.T) {
	// Each subtest needs its own DB: the deletions are destructive and the
	// point is to observe ONE dangling join at a time.
	cases := []struct {
		name       string
		deleteUser string
		// check runs against the single returned pin.
		check func(t *testing.T, p models.PinnedMessageWithDetails)
	}{
		{
			name:       "message author deleted",
			deleteUser: pinAuthor,
			check: func(t *testing.T, p models.PinnedMessageWithDetails) {
				if p.Message == nil {
					t.Fatal("message is nil; the pin should still carry its message")
				}
				if p.Message.Author != nil {
					t.Errorf("author = %+v, want nil for a deleted user", p.Message.Author)
				}
				// The other side is untouched and must still be populated,
				// so a fix that nils out both would not pass.
				if p.PinnedByUser == nil || p.PinnedByUser.Username != "pinner" {
					t.Errorf("pinned_by_user = %+v, want the intact pinner", p.PinnedByUser)
				}
			},
		},
		{
			name:       "pinning user deleted",
			deleteUser: pinPinner,
			check: func(t *testing.T, p models.PinnedMessageWithDetails) {
				if p.PinnedByUser != nil {
					t.Errorf("pinned_by_user = %+v, want nil for a deleted user", p.PinnedByUser)
				}
				if p.Message == nil || p.Message.Author == nil {
					t.Fatal("message author is nil; only the pinner was deleted")
				}
				if p.Message.Author.Username != "pinauthor" {
					t.Errorf("author.username = %q, want %q", p.Message.Author.Username, "pinauthor")
				}
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			db, path := newTestDBWithPath(t)
			seedPinWorld(t, db)

			msgRepo := NewSQLiteMessageRepo(db.Conn)
			pinRepo := NewSQLitePinRepo(db.Conn)
			ctx := context.Background()

			content := "pin me"
			msg := &models.Message{ChannelID: pinChannel, UserID: pinAuthor, Content: &content}
			if err := msgRepo.Create(ctx, msg); err != nil {
				t.Fatalf("Create message: %v", err)
			}
			pin := &models.PinnedMessage{MessageID: msg.ID, ChannelID: pinChannel, PinnedBy: pinPinner}
			if err := pinRepo.Pin(ctx, pin); err != nil {
				t.Fatalf("Pin: %v", err)
			}

			// FKs off, so the delete does NOT cascade the message or the pin
			// away — exactly the orphan shape Turso can produce.
			execWithoutFKs(t, path, `DELETE FROM users WHERE id = '`+tc.deleteUser+`'`)

			// Guard the fixture itself: if the cascade DID fire, the pin is
			// gone and the assertions below would pass vacuously.
			if n := countRows(t, db, `SELECT COUNT(*) FROM pinned_messages WHERE channel_id = ?`, pinChannel); n != 1 {
				t.Fatalf("pinned_messages rows = %d, want 1 — the delete cascaded and the dangling row was never planted", n)
			}

			got, err := pinRepo.GetByChannelID(ctx, pinChannel)
			if err != nil {
				t.Fatalf("GetByChannelID returned an error for the whole listing: %v", err)
			}
			if len(got) != 1 {
				t.Fatalf("pins = %d, want 1 — the pin must survive a deleted user", len(got))
			}
			tc.check(t, got[0])
		})
	}
}
