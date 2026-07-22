// sqliteDMRepo CRUD against a real local SQLite database.
//
// DM storage is the one place in the schema where a wrong column or a missed
// WHERE clause is a privacy incident rather than a display bug: dm_channels is
// the ONLY table that says who may read a DM, and handlers/upload_download.go
// consults it (via GetAttachmentByFileURL → GetMessageByID → GetChannelByID)
// to decide whether to stream an attachment. These tests exercise that whole
// chain against the real schema, plus the message/reaction CRUD around it.
//
// DB harness: testdb_test.go.
package repository

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

// dmUsers seeds three users. Ordering matters for DM channels: the service
// layer sorts the pair so user1_id < user2_id, and the UNIQUE(user1_id,
// user2_id) constraint relies on it.
const (
	dmAlice = "u-alice"
	dmBob   = "u-bob"
	dmCarol = "u-carol"
)

func seedDMUsers(t *testing.T, db *database.DB) {
	t.Helper()
	execSeed(t, db, []seedStmt{
		{`INSERT INTO users (id, username, password_hash) VALUES (?, ?, 'x')`, []any{dmAlice, "alice"}},
		{`INSERT INTO users (id, username, password_hash) VALUES (?, ?, 'x')`, []any{dmBob, "bob"}},
		{`INSERT INTO users (id, username, password_hash) VALUES (?, ?, 'x')`, []any{dmCarol, "carol"}},
	})
}

// newDMChannel creates a channel through the repo and returns it.
func newDMChannel(t *testing.T, ctx context.Context, repo DMRepository, u1, u2, status string) *models.DMChannel {
	t.Helper()
	ch := &models.DMChannel{User1ID: u1, User2ID: u2, Status: status}
	if err := repo.CreateChannel(ctx, ch); err != nil {
		t.Fatalf("CreateChannel(%s,%s): %v", u1, u2, err)
	}
	if ch.ID == "" {
		t.Fatalf("CreateChannel did not populate the generated ID")
	}
	return ch
}

// newDMMessage sends a plaintext message through the repo.
func newDMMessage(t *testing.T, ctx context.Context, repo DMRepository, channelID, userID, content string) *models.DMMessage {
	t.Helper()
	msg := &models.DMMessage{DMChannelID: channelID, UserID: userID, Content: &content}
	if err := repo.CreateMessage(ctx, msg); err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	return msg
}

// ─── Channel CRUD ───

func TestDMRepo_ChannelCRUD(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	repo := NewSQLiteDMRepo(db.Conn)
	ctx := context.Background()

	ch := newDMChannel(t, ctx, repo, dmAlice, dmBob, models.DMStatusPending)

	t.Run("GetChannelByID round-trips the participants", func(t *testing.T) {
		got, err := repo.GetChannelByID(ctx, ch.ID)
		if err != nil {
			t.Fatalf("GetChannelByID: %v", err)
		}
		if got.User1ID != dmAlice || got.User2ID != dmBob {
			t.Errorf("participants = (%s,%s), want (%s,%s)", got.User1ID, got.User2ID, dmAlice, dmBob)
		}
		if got.Status != models.DMStatusPending {
			t.Errorf("status = %q, want %q", got.Status, models.DMStatusPending)
		}
		// E2EE is opt-in (migration 037 default 0).
		if got.E2EEEnabled {
			t.Error("e2ee_enabled defaulted to true, want false")
		}
		if got.LastMessageAt != nil {
			t.Errorf("last_message_at = %v on a channel with no messages, want nil", got.LastMessageAt)
		}
	})

	t.Run("GetChannelByID reports ErrNotFound for an unknown id", func(t *testing.T) {
		_, err := repo.GetChannelByID(ctx, "does-not-exist")
		if !errors.Is(err, pkg.ErrNotFound) {
			t.Fatalf("err = %v, want pkg.ErrNotFound", err)
		}
	})

	t.Run("GetChannelByUsers finds the pair", func(t *testing.T) {
		got, err := repo.GetChannelByUsers(ctx, dmAlice, dmBob)
		if err != nil {
			t.Fatalf("GetChannelByUsers: %v", err)
		}
		if got == nil || got.ID != ch.ID {
			t.Fatalf("GetChannelByUsers = %v, want channel %s", got, ch.ID)
		}
	})

	t.Run("GetChannelByUsers returns (nil,nil) for a pair with no channel", func(t *testing.T) {
		// Deliberately different from GetChannelByID's ErrNotFound: the
		// service layer branches on nil here to decide whether to create one.
		got, err := repo.GetChannelByUsers(ctx, dmAlice, dmCarol)
		if err != nil {
			t.Fatalf("err = %v, want nil", err)
		}
		if got != nil {
			t.Fatalf("channel = %+v, want nil", got)
		}
	})

	t.Run("GetChannelByUsers is order-sensitive", func(t *testing.T) {
		// The repo does NOT normalise the pair — the service must pre-sort.
		// Pinning this stops a future "helpful" swap in the repo from
		// silently creating duplicate channels for the same two people.
		got, err := repo.GetChannelByUsers(ctx, dmBob, dmAlice)
		if err != nil {
			t.Fatalf("err = %v", err)
		}
		if got != nil {
			t.Fatalf("reversed lookup found %+v; the repo is expected to require pre-sorted ids", got)
		}
	})

	t.Run("UpdateChannelStatus and SetInitiatedBy persist", func(t *testing.T) {
		if err := repo.SetInitiatedBy(ctx, ch.ID, dmAlice); err != nil {
			t.Fatalf("SetInitiatedBy: %v", err)
		}
		if err := repo.UpdateChannelStatus(ctx, ch.ID, models.DMStatusAccepted); err != nil {
			t.Fatalf("UpdateChannelStatus: %v", err)
		}
		got, err := repo.GetChannelByID(ctx, ch.ID)
		if err != nil {
			t.Fatalf("GetChannelByID: %v", err)
		}
		if got.Status != models.DMStatusAccepted {
			t.Errorf("status = %q, want accepted", got.Status)
		}
		if got.InitiatedBy == nil || *got.InitiatedBy != dmAlice {
			t.Errorf("initiated_by = %v, want %q", got.InitiatedBy, dmAlice)
		}
	})

	t.Run("SetE2EEEnabled toggles and reports ErrNotFound for a missing channel", func(t *testing.T) {
		if err := repo.SetE2EEEnabled(ctx, ch.ID, true); err != nil {
			t.Fatalf("SetE2EEEnabled: %v", err)
		}
		got, err := repo.GetChannelByID(ctx, ch.ID)
		if err != nil {
			t.Fatalf("GetChannelByID: %v", err)
		}
		if !got.E2EEEnabled {
			t.Error("e2ee_enabled = false after enabling")
		}
		if err := repo.SetE2EEEnabled(ctx, "nope", true); !errors.Is(err, pkg.ErrNotFound) {
			t.Errorf("SetE2EEEnabled on a missing channel = %v, want ErrNotFound", err)
		}
	})

	t.Run("UNIQUE(user1_id,user2_id) rejects a duplicate channel", func(t *testing.T) {
		dup := &models.DMChannel{User1ID: dmAlice, User2ID: dmBob, Status: models.DMStatusAccepted}
		if err := repo.CreateChannel(ctx, dup); err == nil {
			t.Fatal("creating a second channel for the same pair succeeded; the UNIQUE constraint is gone")
		}
	})
}

// TestDMRepo_ListChannels covers the sidebar query: it must return only the
// caller's channels, hide the ones the caller hid, and sort pinned first.
func TestDMRepo_ListChannels(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	repo := NewSQLiteDMRepo(db.Conn)
	ctx := context.Background()

	withBob := newDMChannel(t, ctx, repo, dmAlice, dmBob, models.DMStatusAccepted)
	withCarol := newDMChannel(t, ctx, repo, dmAlice, dmCarol, models.DMStatusAccepted)
	// A channel Alice is not part of — must never appear in her list.
	notHers := newDMChannel(t, ctx, repo, dmBob, dmCarol, models.DMStatusAccepted)

	t.Run("returns only the caller's channels with the other participant attached", func(t *testing.T) {
		list, err := repo.ListChannels(ctx, dmAlice)
		if err != nil {
			t.Fatalf("ListChannels: %v", err)
		}
		if len(list) != 2 {
			t.Fatalf("channels = %d, want 2 (%+v)", len(list), list)
		}
		for _, c := range list {
			if c.ID == notHers.ID {
				t.Fatalf("a channel the caller is not part of leaked into the list: %s", c.ID)
			}
			if c.OtherUser == nil {
				t.Fatalf("other_user is nil for channel %s", c.ID)
			}
			if c.OtherUser.ID == dmAlice {
				t.Errorf("other_user is the caller themselves for channel %s", c.ID)
			}
		}
	})

	t.Run("empty result is a non-nil slice", func(t *testing.T) {
		// The handler serialises this straight to JSON; nil would render as
		// `null` and break clients that iterate it.
		list, err := repo.ListChannels(ctx, "nobody")
		if err != nil {
			t.Fatalf("ListChannels: %v", err)
		}
		if list == nil {
			t.Fatal("empty list is nil, want an empty slice")
		}
		if len(list) != 0 {
			t.Fatalf("channels = %d, want 0", len(list))
		}
	})

	t.Run("hidden channels are excluded and pinned ones sort first", func(t *testing.T) {
		execSeed(t, db, []seedStmt{
			{`INSERT INTO user_dm_settings (user_id, dm_channel_id, is_hidden) VALUES (?, ?, 1)`,
				[]any{dmAlice, withBob.ID}},
			{`INSERT INTO user_dm_settings (user_id, dm_channel_id, is_pinned) VALUES (?, ?, 1)`,
				[]any{dmAlice, withCarol.ID}},
		})

		list, err := repo.ListChannels(ctx, dmAlice)
		if err != nil {
			t.Fatalf("ListChannels: %v", err)
		}
		if len(list) != 1 {
			t.Fatalf("channels = %d, want 1 (hidden one must be filtered out): %+v", len(list), list)
		}
		if list[0].ID != withCarol.ID {
			t.Errorf("remaining channel = %s, want %s", list[0].ID, withCarol.ID)
		}
		if !list[0].IsPinned {
			t.Error("is_pinned = false, want true")
		}
		// Settings are per-user: Bob still sees the channel Alice hid.
		bobList, err := repo.ListChannels(ctx, dmBob)
		if err != nil {
			t.Fatalf("ListChannels(bob): %v", err)
		}
		var found bool
		for _, c := range bobList {
			if c.ID == withBob.ID {
				found = true
			}
		}
		if !found {
			t.Error("Alice hiding a channel also hid it for Bob — dm settings must be per-user")
		}
	})
}

// ─── Message CRUD ───

func TestDMRepo_MessageCRUD(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	repo := NewSQLiteDMRepo(db.Conn)
	ctx := context.Background()
	ch := newDMChannel(t, ctx, repo, dmAlice, dmBob, models.DMStatusAccepted)

	t.Run("create then read back with the author joined in", func(t *testing.T) {
		msg := newDMMessage(t, ctx, repo, ch.ID, dmAlice, "selam")
		if msg.ID == "" || msg.CreatedAt.IsZero() {
			t.Fatalf("CreateMessage did not populate id/created_at: %+v", msg)
		}

		got, err := repo.GetMessageByID(ctx, msg.ID)
		if err != nil {
			t.Fatalf("GetMessageByID: %v", err)
		}
		if got.Content == nil || *got.Content != "selam" {
			t.Errorf("content = %v, want %q", got.Content, "selam")
		}
		if got.DMChannelID != ch.ID {
			t.Errorf("dm_channel_id = %q, want %q", got.DMChannelID, ch.ID)
		}
		if got.Author == nil || got.Author.ID != dmAlice {
			t.Fatalf("author = %+v, want %s", got.Author, dmAlice)
		}
		if got.Author.Username != "alice" {
			t.Errorf("author.username = %q, want alice", got.Author.Username)
		}
		if got.IsPinned {
			t.Error("is_pinned defaulted to true")
		}
	})

	t.Run("an empty content string is stored as NULL, not as an empty string", func(t *testing.T) {
		// File-only messages come through with Content == "". CreateMessage
		// deliberately nils it so the FTS trigger (WHEN content IS NOT NULL)
		// doesn't index a blank row.
		empty := ""
		msg := &models.DMMessage{DMChannelID: ch.ID, UserID: dmAlice, Content: &empty}
		if err := repo.CreateMessage(ctx, msg); err != nil {
			t.Fatalf("CreateMessage: %v", err)
		}
		got, err := repo.GetMessageByID(ctx, msg.ID)
		if err != nil {
			t.Fatalf("GetMessageByID: %v", err)
		}
		if got.Content != nil {
			t.Errorf("content = %q, want nil (NULL)", *got.Content)
		}
		if n := countRows(t, db, `SELECT COUNT(*) FROM dm_messages WHERE id = ? AND content IS NULL`, msg.ID); n != 1 {
			t.Errorf("row is not NULL-content in the table")
		}
	})

	t.Run("GetMessageByID reports ErrNotFound", func(t *testing.T) {
		if _, err := repo.GetMessageByID(ctx, "nope"); !errors.Is(err, pkg.ErrNotFound) {
			t.Fatalf("err = %v, want ErrNotFound", err)
		}
	})

	t.Run("update edits content and stamps edited_at", func(t *testing.T) {
		msg := newDMMessage(t, ctx, repo, ch.ID, dmAlice, "ilk hali")
		if err := repo.UpdateMessage(ctx, msg.ID, &models.UpdateDMMessageRequest{Content: "duzeltilmis"}); err != nil {
			t.Fatalf("UpdateMessage: %v", err)
		}
		got, err := repo.GetMessageByID(ctx, msg.ID)
		if err != nil {
			t.Fatalf("GetMessageByID: %v", err)
		}
		if got.Content == nil || *got.Content != "duzeltilmis" {
			t.Errorf("content = %v, want %q", got.Content, "duzeltilmis")
		}
		if got.EditedAt == nil {
			t.Error("edited_at is nil after an edit")
		}
	})

	t.Run("update of a missing message reports ErrNotFound", func(t *testing.T) {
		err := repo.UpdateMessage(ctx, "nope", &models.UpdateDMMessageRequest{Content: "x"})
		if !errors.Is(err, pkg.ErrNotFound) {
			t.Fatalf("err = %v, want ErrNotFound", err)
		}
	})

	t.Run("delete removes the row and is not idempotent", func(t *testing.T) {
		msg := newDMMessage(t, ctx, repo, ch.ID, dmAlice, "silinecek")
		if err := repo.DeleteMessage(ctx, msg.ID); err != nil {
			t.Fatalf("DeleteMessage: %v", err)
		}
		if _, err := repo.GetMessageByID(ctx, msg.ID); !errors.Is(err, pkg.ErrNotFound) {
			t.Errorf("message still readable after delete: %v", err)
		}
		if err := repo.DeleteMessage(ctx, msg.ID); !errors.Is(err, pkg.ErrNotFound) {
			t.Errorf("second delete = %v, want ErrNotFound (the service relies on this to 404)", err)
		}
	})
}

// TestDMRepo_E2EEMessageRouting: an encrypted DM stores its payload in
// ciphertext with content NULL, and an E2EE edit must rewrite the CIPHERTEXT
// rather than the content column — the channel-message twin of this had a bug
// where the post-edit ciphertext was broadcast but never persisted, so history
// showed the pre-edit blob after a reload.
func TestDMRepo_E2EEMessageRouting(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	repo := NewSQLiteDMRepo(db.Conn)
	ctx := context.Background()
	ch := newDMChannel(t, ctx, repo, dmAlice, dmBob, models.DMStatusAccepted)

	ct := "cipher-v1"
	dev := "device-1"
	meta := `{"alg":"x"}`
	msg := &models.DMMessage{
		DMChannelID:       ch.ID,
		UserID:            dmAlice,
		EncryptionVersion: 1,
		Ciphertext:        &ct,
		SenderDeviceID:    &dev,
		E2EEMetadata:      &meta,
	}
	if err := repo.CreateMessage(ctx, msg); err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	got, err := repo.GetMessageByID(ctx, msg.ID)
	if err != nil {
		t.Fatalf("GetMessageByID: %v", err)
	}
	if got.EncryptionVersion != 1 {
		t.Errorf("encryption_version = %d, want 1", got.EncryptionVersion)
	}
	if got.Content != nil {
		t.Errorf("content = %q on an E2EE message, want NULL", *got.Content)
	}
	if got.Ciphertext == nil || *got.Ciphertext != ct {
		t.Fatalf("ciphertext = %v, want %q", got.Ciphertext, ct)
	}
	if got.SenderDeviceID == nil || *got.SenderDeviceID != dev {
		t.Errorf("sender_device_id = %v, want %q", got.SenderDeviceID, dev)
	}

	newCT := "cipher-v2"
	if err := repo.UpdateMessage(ctx, msg.ID, &models.UpdateDMMessageRequest{
		EncryptionVersion: 1,
		Ciphertext:        &newCT,
		SenderDeviceID:    &dev,
		E2EEMetadata:      &meta,
	}); err != nil {
		t.Fatalf("UpdateMessage: %v", err)
	}
	got, err = repo.GetMessageByID(ctx, msg.ID)
	if err != nil {
		t.Fatalf("GetMessageByID: %v", err)
	}
	if got.Ciphertext == nil || *got.Ciphertext != newCT {
		t.Fatalf("ciphertext after edit = %v, want %q (edit did not persist)", got.Ciphertext, newCT)
	}
	if got.Content != nil {
		t.Errorf("an E2EE edit wrote plaintext into content: %q", *got.Content)
	}
	if got.EditedAt == nil {
		t.Error("edited_at is nil after an E2EE edit")
	}
}

// TestDMRepo_GetMessagesPagination pins the cursor contract: DESC order, the
// limit is honoured, and `before` excludes the cursor message itself.
func TestDMRepo_GetMessagesPagination(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	repo := NewSQLiteDMRepo(db.Conn)
	ctx := context.Background()
	ch := newDMChannel(t, ctx, repo, dmAlice, dmBob, models.DMStatusAccepted)
	other := newDMChannel(t, ctx, repo, dmAlice, dmCarol, models.DMStatusAccepted)

	// created_at has 1-second resolution in this schema, so each message
	// gets an explicit, distinct-per-second stamp rather than relying on
	// insert order — this keeps the ordering assertions below unambiguous.
	// The case where multiple messages DO share a second, and pagination
	// must not lose any of them, is exercised separately at the bottom of
	// this test.
	ids := make([]string, 4)
	for i := range ids {
		m := newDMMessage(t, ctx, repo, ch.ID, dmAlice, string(rune('a'+i)))
		ids[i] = m.ID
		if _, err := db.Conn.Exec(
			`UPDATE dm_messages SET created_at = datetime('2026-01-01 00:00:0'||?) WHERE id = ?`, i, m.ID,
		); err != nil {
			t.Fatalf("stamp created_at: %v", err)
		}
	}
	// A message in a different channel that must never appear.
	newDMMessage(t, ctx, repo, other.ID, dmAlice, "baska kanal")

	t.Run("newest first, scoped to the channel", func(t *testing.T) {
		got, err := repo.GetMessages(ctx, ch.ID, "", 50)
		if err != nil {
			t.Fatalf("GetMessages: %v", err)
		}
		if len(got) != 4 {
			t.Fatalf("messages = %d, want 4", len(got))
		}
		if got[0].ID != ids[3] {
			t.Errorf("first message = %s, want the newest (%s)", got[0].ID, ids[3])
		}
		for _, m := range got {
			if m.DMChannelID != ch.ID {
				t.Fatalf("message from another channel leaked: %s", m.ID)
			}
		}
	})

	t.Run("limit is honoured", func(t *testing.T) {
		got, err := repo.GetMessages(ctx, ch.ID, "", 2)
		if err != nil {
			t.Fatalf("GetMessages: %v", err)
		}
		if len(got) != 2 {
			t.Fatalf("messages = %d, want 2", len(got))
		}
	})

	t.Run("before cursor excludes the cursor message and everything newer", func(t *testing.T) {
		got, err := repo.GetMessages(ctx, ch.ID, ids[2], 50)
		if err != nil {
			t.Fatalf("GetMessages: %v", err)
		}
		if len(got) != 2 {
			t.Fatalf("messages before ids[2] = %d, want 2", len(got))
		}
		for _, m := range got {
			if m.ID == ids[2] || m.ID == ids[3] {
				t.Errorf("cursor message or a newer one came back: %s", m.ID)
			}
		}
	})

	t.Run("empty channel returns a non-nil empty slice", func(t *testing.T) {
		empty := newDMChannel(t, ctx, repo, dmBob, dmCarol, models.DMStatusAccepted)
		got, err := repo.GetMessages(ctx, empty.ID, "", 50)
		if err != nil {
			t.Fatalf("GetMessages: %v", err)
		}
		if got == nil {
			t.Fatal("empty result is nil, want an empty slice")
		}
	})

	// REGRESSION GUARD — this is the case the (created_at, id) compound
	// cursor exists for. created_at only has second resolution; id is
	// random hex. Four messages below share the exact same created_at,
	// newer than every message seeded above, so a page boundary is forced
	// to fall inside the tied group. Before the fix, the cursor branch
	// filtered on `created_at < (SELECT created_at ... WHERE id = ?)`
	// alone: once the cursor lands on a tied row, every other row with the
	// SAME created_at fails that strict `<` forever, so the second page
	// silently skipped straight past the rest of the tie and those
	// messages were gone for good — not just delayed, permanently
	// unreachable via pagination.
	t.Run("messages sharing a created_at second all survive a page boundary", func(t *testing.T) {
		tieIDs := make([]string, 4)
		for i := range tieIDs {
			m := newDMMessage(t, ctx, repo, ch.ID, dmAlice, "es-"+string(rune('a'+i)))
			tieIDs[i] = m.ID
			if _, err := db.Conn.Exec(
				`UPDATE dm_messages SET created_at = '2026-01-01 00:01:00' WHERE id = ?`, m.ID,
			); err != nil {
				t.Fatalf("stamp created_at: %v", err)
			}
		}

		page1, err := repo.GetMessages(ctx, ch.ID, "", 2)
		if err != nil {
			t.Fatalf("GetMessages page 1: %v", err)
		}
		if len(page1) != 2 {
			t.Fatalf("page 1 = %d messages, want 2", len(page1))
		}

		cursor := page1[len(page1)-1].ID
		page2, err := repo.GetMessages(ctx, ch.ID, cursor, 2)
		if err != nil {
			t.Fatalf("GetMessages page 2: %v", err)
		}
		if len(page2) != 2 {
			t.Fatalf("page 2 = %d messages, want 2 — the rest of the tied group went missing at the page boundary", len(page2))
		}

		seen := make(map[string]int, len(tieIDs))
		for _, m := range page1 {
			seen[m.ID]++
		}
		for _, m := range page2 {
			seen[m.ID]++
		}
		for _, id := range tieIDs {
			if seen[id] != 1 {
				t.Errorf("tie message %s appeared %d time(s) across the two pages, want exactly 1", id, seen[id])
			}
		}
	})
}

// TestDMRepo_ReplyReference: reply_to_id has no FK on purpose (Discord
// behaviour) — deleting the referenced message must leave the reply standing
// with an ID-only reference so the client can render "message deleted".
func TestDMRepo_ReplyReference(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	repo := NewSQLiteDMRepo(db.Conn)
	ctx := context.Background()
	ch := newDMChannel(t, ctx, repo, dmAlice, dmBob, models.DMStatusAccepted)

	orig := newDMMessage(t, ctx, repo, ch.ID, dmAlice, "orijinal")
	reply := &models.DMMessage{DMChannelID: ch.ID, UserID: dmBob, Content: strPtr("cevap"), ReplyToID: &orig.ID}
	if err := repo.CreateMessage(ctx, reply); err != nil {
		t.Fatalf("CreateMessage(reply): %v", err)
	}

	got, err := repo.GetMessageByID(ctx, reply.ID)
	if err != nil {
		t.Fatalf("GetMessageByID: %v", err)
	}
	if got.ReferencedMessage == nil {
		t.Fatal("referenced_message is nil on a reply")
	}
	if got.ReferencedMessage.Content == nil || *got.ReferencedMessage.Content != "orijinal" {
		t.Errorf("referenced content = %v, want %q", got.ReferencedMessage.Content, "orijinal")
	}
	if got.ReferencedMessage.Author == nil || got.ReferencedMessage.Author.ID != dmAlice {
		t.Errorf("referenced author = %+v, want %s", got.ReferencedMessage.Author, dmAlice)
	}

	if err := repo.DeleteMessage(ctx, orig.ID); err != nil {
		t.Fatalf("DeleteMessage: %v", err)
	}
	got, err = repo.GetMessageByID(ctx, reply.ID)
	if err != nil {
		t.Fatalf("reply disappeared when the referenced message was deleted: %v", err)
	}
	if got.ReferencedMessage == nil {
		t.Fatal("referenced_message went nil; the client needs the ID to show 'deleted message'")
	}
	if got.ReferencedMessage.ID != orig.ID {
		t.Errorf("referenced id = %q, want %q", got.ReferencedMessage.ID, orig.ID)
	}
	if got.ReferencedMessage.Content != nil {
		t.Errorf("referenced content = %q after deletion, want nil", *got.ReferencedMessage.Content)
	}
}

// ─── Reactions ───

func TestDMRepo_Reactions(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	repo := NewSQLiteDMRepo(db.Conn)
	ctx := context.Background()
	ch := newDMChannel(t, ctx, repo, dmAlice, dmBob, models.DMStatusAccepted)
	msg := newDMMessage(t, ctx, repo, ch.ID, dmAlice, "tepki ver")

	t.Run("toggle adds then removes", func(t *testing.T) {
		added, err := repo.ToggleReaction(ctx, msg.ID, dmBob, "👍")
		if err != nil {
			t.Fatalf("ToggleReaction: %v", err)
		}
		if !added {
			t.Fatal("first toggle returned added=false")
		}
		groups, err := repo.GetReactionsByMessageID(ctx, msg.ID)
		if err != nil {
			t.Fatalf("GetReactionsByMessageID: %v", err)
		}
		if len(groups) != 1 || groups[0].Emoji != "👍" || groups[0].Count != 1 {
			t.Fatalf("groups = %+v, want one 👍 with count 1", groups)
		}
		if len(groups[0].Users) != 1 || groups[0].Users[0] != dmBob {
			t.Errorf("users = %v, want [%s]", groups[0].Users, dmBob)
		}

		added, err = repo.ToggleReaction(ctx, msg.ID, dmBob, "👍")
		if err != nil {
			t.Fatalf("ToggleReaction (second): %v", err)
		}
		if added {
			t.Fatal("second toggle returned added=true; the UNIQUE constraint should have turned it into a removal")
		}
		groups, err = repo.GetReactionsByMessageID(ctx, msg.ID)
		if err != nil {
			t.Fatalf("GetReactionsByMessageID: %v", err)
		}
		if len(groups) != 0 {
			t.Errorf("groups = %+v after removal, want none", groups)
		}
	})

	t.Run("distinct users aggregate into one group", func(t *testing.T) {
		for _, u := range []string{dmAlice, dmBob} {
			if _, err := repo.ToggleReaction(ctx, msg.ID, u, "🔥"); err != nil {
				t.Fatalf("ToggleReaction(%s): %v", u, err)
			}
		}
		groups, err := repo.GetReactionsByMessageID(ctx, msg.ID)
		if err != nil {
			t.Fatalf("GetReactionsByMessageID: %v", err)
		}
		if len(groups) != 1 {
			t.Fatalf("groups = %d, want 1", len(groups))
		}
		if groups[0].Count != 2 || len(groups[0].Users) != 2 {
			t.Errorf("group = %+v, want count 2 with 2 users", groups[0])
		}
	})

	t.Run("batch load keys by message id and skips messages with none", func(t *testing.T) {
		other := newDMMessage(t, ctx, repo, ch.ID, dmBob, "tepkisiz")
		byMsg, err := repo.GetReactionsByMessageIDs(ctx, []string{msg.ID, other.ID})
		if err != nil {
			t.Fatalf("GetReactionsByMessageIDs: %v", err)
		}
		if len(byMsg[msg.ID]) != 1 {
			t.Errorf("groups for msg = %+v, want 1", byMsg[msg.ID])
		}
		if _, present := byMsg[other.ID]; present {
			t.Errorf("a message with no reactions got an entry: %+v", byMsg[other.ID])
		}
	})

	t.Run("empty id list returns an empty map, not nil", func(t *testing.T) {
		byMsg, err := repo.GetReactionsByMessageIDs(ctx, nil)
		if err != nil {
			t.Fatalf("GetReactionsByMessageIDs: %v", err)
		}
		if byMsg == nil {
			t.Fatal("result is nil, want an empty map")
		}
	})

	t.Run("deleting the message cascades its reactions away", func(t *testing.T) {
		victim := newDMMessage(t, ctx, repo, ch.ID, dmAlice, "silinecek")
		if _, err := repo.ToggleReaction(ctx, victim.ID, dmBob, "😀"); err != nil {
			t.Fatalf("ToggleReaction: %v", err)
		}
		if err := repo.DeleteMessage(ctx, victim.ID); err != nil {
			t.Fatalf("DeleteMessage: %v", err)
		}
		if n := countRows(t, db, `SELECT COUNT(*) FROM dm_reactions WHERE dm_message_id = ?`, victim.ID); n != 0 {
			t.Errorf("orphan reactions = %d, want 0 (ON DELETE CASCADE)", n)
		}
	})
}

// ─── Pins ───

func TestDMRepo_Pins(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	repo := NewSQLiteDMRepo(db.Conn)
	ctx := context.Background()
	ch := newDMChannel(t, ctx, repo, dmAlice, dmBob, models.DMStatusAccepted)
	msg := newDMMessage(t, ctx, repo, ch.ID, dmAlice, "sabitle")
	newDMMessage(t, ctx, repo, ch.ID, dmBob, "sabitlenmemis")

	if err := repo.PinMessage(ctx, msg.ID); err != nil {
		t.Fatalf("PinMessage: %v", err)
	}
	pinned, err := repo.GetPinnedMessages(ctx, ch.ID)
	if err != nil {
		t.Fatalf("GetPinnedMessages: %v", err)
	}
	if len(pinned) != 1 || pinned[0].ID != msg.ID {
		t.Fatalf("pinned = %+v, want just %s", pinned, msg.ID)
	}
	if !pinned[0].IsPinned {
		t.Error("is_pinned = false on a pinned message")
	}

	if err := repo.UnpinMessage(ctx, msg.ID); err != nil {
		t.Fatalf("UnpinMessage: %v", err)
	}
	pinned, err = repo.GetPinnedMessages(ctx, ch.ID)
	if err != nil {
		t.Fatalf("GetPinnedMessages: %v", err)
	}
	if len(pinned) != 0 {
		t.Errorf("pinned = %+v after unpin, want none", pinned)
	}

	if err := repo.PinMessage(ctx, "nope"); !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("PinMessage(missing) = %v, want ErrNotFound", err)
	}
	if err := repo.UnpinMessage(ctx, "nope"); !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("UnpinMessage(missing) = %v, want ErrNotFound", err)
	}
}

// ─── Attachments ───

// TestDMRepo_Attachments covers the lookup the download handler depends on
// plus the batch loader the message list uses.
func TestDMRepo_Attachments(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	repo := NewSQLiteDMRepo(db.Conn)
	ctx := context.Background()
	ch := newDMChannel(t, ctx, repo, dmAlice, dmBob, models.DMStatusAccepted)
	msg := newDMMessage(t, ctx, repo, ch.ID, dmAlice, "dosya")

	size := int64(1234)
	mime := "image/png"
	att := &models.DMAttachment{
		DMMessageID: msg.ID,
		Filename:    "kedi.png",
		FileURL:     "/api/uploads/abcd1234_kedi.png",
		FileSize:    &size,
		MimeType:    &mime,
	}
	if err := repo.CreateAttachment(ctx, att); err != nil {
		t.Fatalf("CreateAttachment: %v", err)
	}
	if att.ID == "" || att.CreatedAt.IsZero() {
		t.Fatalf("CreateAttachment did not populate id/created_at: %+v", att)
	}

	t.Run("GetAttachmentByFileURL resolves back to the owning message", func(t *testing.T) {
		got, err := repo.GetAttachmentByFileURL(ctx, att.FileURL)
		if err != nil {
			t.Fatalf("GetAttachmentByFileURL: %v", err)
		}
		// This is the field the download handler uses to reach the DM
		// channel and check participation.
		if got.DMMessageID != msg.ID {
			t.Errorf("dm_message_id = %q, want %q", got.DMMessageID, msg.ID)
		}
		if got.Filename != "kedi.png" || got.FileSize == nil || *got.FileSize != size {
			t.Errorf("attachment = %+v, want the seeded values", got)
		}
	})

	t.Run("GetAttachmentByFileURL reports ErrNotFound for an unknown url", func(t *testing.T) {
		_, err := repo.GetAttachmentByFileURL(ctx, "/api/uploads/does-not-exist.png")
		if !errors.Is(err, pkg.ErrNotFound) {
			t.Fatalf("err = %v, want ErrNotFound (the handler falls through to public serving on this)", err)
		}
	})

	t.Run("duplicate file_url is rejected by the unique index from migration 072", func(t *testing.T) {
		// Two rows sharing a file_url would make the download handler's ACL
		// depend on scan order — which conversation gates the file would be
		// whichever row LIMIT 1 happened to return.
		dup := &models.DMAttachment{DMMessageID: msg.ID, Filename: "kopya.png", FileURL: att.FileURL}
		if err := repo.CreateAttachment(ctx, dup); err == nil {
			t.Fatal("a second dm_attachments row with the same file_url was accepted")
		}
	})

	t.Run("batch load groups by message id", func(t *testing.T) {
		msg2 := newDMMessage(t, ctx, repo, ch.ID, dmBob, "ikinci")
		second := &models.DMAttachment{DMMessageID: msg2.ID, Filename: "b.png", FileURL: "/api/uploads/ffff_b.png"}
		if err := repo.CreateAttachment(ctx, second); err != nil {
			t.Fatalf("CreateAttachment: %v", err)
		}
		noAtt := newDMMessage(t, ctx, repo, ch.ID, dmAlice, "eksiz")

		byMsg, err := repo.GetAttachmentsByMessageIDs(ctx, []string{msg.ID, msg2.ID, noAtt.ID})
		if err != nil {
			t.Fatalf("GetAttachmentsByMessageIDs: %v", err)
		}
		if len(byMsg[msg.ID]) != 1 || byMsg[msg.ID][0].Filename != "kedi.png" {
			t.Errorf("attachments for msg = %+v", byMsg[msg.ID])
		}
		if len(byMsg[msg2.ID]) != 1 || byMsg[msg2.ID][0].Filename != "b.png" {
			t.Errorf("attachments for msg2 = %+v", byMsg[msg2.ID])
		}
		if _, present := byMsg[noAtt.ID]; present {
			t.Errorf("a message with no attachments got an entry")
		}
	})

	t.Run("empty id list returns an empty map, not nil", func(t *testing.T) {
		byMsg, err := repo.GetAttachmentsByMessageIDs(ctx, nil)
		if err != nil {
			t.Fatalf("GetAttachmentsByMessageIDs: %v", err)
		}
		if byMsg == nil {
			t.Fatal("result is nil, want an empty map")
		}
	})

	t.Run("deleting the message cascades its attachments away", func(t *testing.T) {
		victim := newDMMessage(t, ctx, repo, ch.ID, dmAlice, "silinecek")
		if err := repo.CreateAttachment(ctx, &models.DMAttachment{
			DMMessageID: victim.ID, Filename: "x.png", FileURL: "/api/uploads/1111_x.png",
		}); err != nil {
			t.Fatalf("CreateAttachment: %v", err)
		}
		if err := repo.DeleteMessage(ctx, victim.ID); err != nil {
			t.Fatalf("DeleteMessage: %v", err)
		}
		if n := countRows(t, db, `SELECT COUNT(*) FROM dm_attachments WHERE dm_message_id = ?`, victim.ID); n != 0 {
			t.Errorf("orphan attachments = %d, want 0 — an orphan row is a file nobody's ACL can gate", n)
		}
	})
}

// TestDMRepo_DeleteChannelRemovesMessages: DeleteChannel deletes the messages
// explicitly before the channel row. If it ever stopped doing so and the FK
// cascade were also lost, the attachments of those messages would keep
// resolving in GetAttachmentByFileURL while GetChannelByID 404s — and the
// download handler treats a missing channel as 404, not as "deny", so the
// blast radius is worth a test.
func TestDMRepo_DeleteChannelRemovesMessages(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	repo := NewSQLiteDMRepo(db.Conn)
	ctx := context.Background()

	ch := newDMChannel(t, ctx, repo, dmAlice, dmBob, models.DMStatusAccepted)
	keep := newDMChannel(t, ctx, repo, dmAlice, dmCarol, models.DMStatusAccepted)
	newDMMessage(t, ctx, repo, ch.ID, dmAlice, "gidecek")
	newDMMessage(t, ctx, repo, ch.ID, dmBob, "bu da")
	newDMMessage(t, ctx, repo, keep.ID, dmAlice, "kalacak")

	if err := repo.DeleteChannel(ctx, ch.ID); err != nil {
		t.Fatalf("DeleteChannel: %v", err)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM dm_messages WHERE dm_channel_id = ?`, ch.ID); n != 0 {
		t.Errorf("messages left in the deleted channel = %d, want 0", n)
	}
	if _, err := repo.GetChannelByID(ctx, ch.ID); !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("channel still readable after delete: %v", err)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM dm_messages WHERE dm_channel_id = ?`, keep.ID); n != 1 {
		t.Errorf("other channel's messages = %d, want 1 (collateral damage)", n)
	}
}

// TestDMRepo_CountMessagesBySender backs the DM-request rule (a non-friend may
// send exactly one message before the recipient accepts).
func TestDMRepo_CountMessagesBySender(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	repo := NewSQLiteDMRepo(db.Conn)
	ctx := context.Background()
	ch := newDMChannel(t, ctx, repo, dmAlice, dmBob, models.DMStatusPending)

	if n, err := repo.CountMessagesBySender(ctx, ch.ID, dmAlice); err != nil || n != 0 {
		t.Fatalf("count = %d, err = %v, want 0/nil", n, err)
	}
	newDMMessage(t, ctx, repo, ch.ID, dmAlice, "istek")
	newDMMessage(t, ctx, repo, ch.ID, dmBob, "cevap")

	if n, err := repo.CountMessagesBySender(ctx, ch.ID, dmAlice); err != nil || n != 1 {
		t.Errorf("alice count = %d, err = %v, want 1", n, err)
	}
	if n, err := repo.CountMessagesBySender(ctx, ch.ID, dmBob); err != nil || n != 1 {
		t.Errorf("bob count = %d, err = %v, want 1", n, err)
	}
}

func strPtr(s string) *string { return &s }
