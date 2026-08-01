// sqlitePinRepo against a real local SQLite database.
//
// REGRESSION GUARD (security scan 2026-07-31, finding N-09 follow-up):
// PinnedMessageWithDetails.Message.Author and .PinnedByUser moved from
// *models.User to *models.PublicUser, which requires status/custom_status/
// created_at, but scanPin's SELECT list never picked up pb.status at all
// (author's u.custom_status and u.created_at were also missing). A wrong
// column here serializes pinned_by_user.status as "" — a value outside the
// UserStatus enum the client and openapi contract declare — and the pin
// panel's author card shows a null custom status and a year-1 "member
// since" date.
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
		{`INSERT INTO users (id, username, status, password_hash) VALUES (?, ?, ?, 'x')`,
			[]any{pinPinner, "pinner", "idle"}},
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
