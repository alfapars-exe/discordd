// sqliteMessageRepo CRUD against a real local SQLite database.
//
// Every method here is a hand-written SQL string with a hand-matched Scan
// argument list across three LEFT JOINs (author, replied-to message, that
// message's author). A column added in the SELECT but not in the Scan — or
// the reverse — is a runtime error no compiler catches and no mock reproduces,
// which is why these run against the real migrated schema.
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

const (
	msgChannel      = "chan-msg"
	msgOtherChannel = "chan-other"
	msgAuthor       = "u-author"
	msgSecondUser   = "u-second"
)

// seedMessageWorld takes testing.TB (not *testing.T) so sqlite_message_bench_test.go
// can reuse this fixture from a *testing.B — every existing *testing.T caller
// already satisfies TB, so this is a pure signature widening.
func seedMessageWorld(t testing.TB, db *database.DB) {
	t.Helper()
	execSeed(t, db, []seedStmt{
		{`INSERT INTO users (id, username, display_name, password_hash) VALUES (?, ?, ?, 'x')`,
			[]any{msgAuthor, "author", "Yazar"}},
		{`INSERT INTO users (id, username, password_hash) VALUES (?, ?, 'x')`,
			[]any{msgSecondUser, "second"}},
		{`INSERT INTO channels (id, name, type, server_id) VALUES (?, ?, 'text', 'srv-1')`,
			[]any{msgChannel, "genel"}},
		{`INSERT INTO channels (id, name, type, server_id) VALUES (?, ?, 'text', 'srv-1')`,
			[]any{msgOtherChannel, "diger"}},
	})
}

// newMessage creates a plaintext message through the repo. testing.TB (see
// seedMessageWorld above) so BenchmarkMessageRepo_* can build its ~1000-row
// fixture with the same helper the correctness tests use.
func newMessage(t testing.TB, ctx context.Context, repo MessageRepository, channelID, userID, content string) *models.Message {
	t.Helper()
	msg := &models.Message{ChannelID: channelID, UserID: userID, Content: &content}
	if err := repo.Create(ctx, msg); err != nil {
		t.Fatalf("Create: %v", err)
	}
	return msg
}

func TestMessageRepo_CreateGetDelete(t *testing.T) {
	db, dbPath := newTestDBWithPath(t)
	seedMessageWorld(t, db)
	repo := NewSQLiteMessageRepo(db.Conn)
	ctx := context.Background()

	t.Run("create populates the generated id and timestamp", func(t *testing.T) {
		msg := newMessage(t, ctx, repo, msgChannel, msgAuthor, "merhaba")
		if msg.ID == "" {
			t.Fatal("Create did not populate the RETURNING id")
		}
		if msg.CreatedAt.IsZero() {
			t.Fatal("Create did not populate created_at")
		}
	})

	t.Run("get by id joins the author in without the password hash", func(t *testing.T) {
		msg := newMessage(t, ctx, repo, msgChannel, msgAuthor, "selam")
		got, err := repo.GetByID(ctx, msg.ID)
		if err != nil {
			t.Fatalf("GetByID: %v", err)
		}
		if got.Content == nil || *got.Content != "selam" {
			t.Errorf("content = %v, want %q", got.Content, "selam")
		}
		if got.ChannelID != msgChannel {
			t.Errorf("channel_id = %q, want %q", got.ChannelID, msgChannel)
		}
		if got.Author == nil {
			t.Fatal("author is nil")
		}
		if got.Author.ID != msgAuthor || got.Author.Username != "author" {
			t.Errorf("author = %+v, want %s/author", got.Author, msgAuthor)
		}
		if got.Author.DisplayName == nil || *got.Author.DisplayName != "Yazar" {
			t.Errorf("author.display_name = %v, want Yazar", got.Author.DisplayName)
		}
		// The query explicitly blanks this — a leak here would ship a bcrypt
		// hash to every client rendering the channel.
		if got.Author.PasswordHash != "" {
			t.Errorf("password_hash leaked into the message author: %q", got.Author.PasswordHash)
		}
		if got.ReferencedMessage != nil {
			t.Errorf("referenced_message = %+v on a non-reply, want nil", got.ReferencedMessage)
		}
	})

	t.Run("get by id reports ErrNotFound", func(t *testing.T) {
		if _, err := repo.GetByID(ctx, "nope"); !errors.Is(err, pkg.ErrNotFound) {
			t.Fatalf("err = %v, want ErrNotFound", err)
		}
	})

	t.Run("a message whose author is missing stays readable with a nil author", func(t *testing.T) {
		// KNOWN BUG — see the note on TestMessageRepo_NilAuthorScan_KnownBug
		// at the bottom of this file. sqlite_message.go documents this LEFT
		// JOIN as "message stays visible even if author is deleted", but the
		// scan targets for the joined user columns are plain strings, so a
		// NULL author makes the whole query error instead.
		// database.New enforces foreign keys, so the dangling reference has to
		// be planted through a second connection with enforcement off — which
		// is also the realistic provenance of such a row.
		msg := newMessage(t, ctx, repo, msgChannel, msgAuthor, "hayalet")
		execWithoutFKs(t, dbPath,
			`UPDATE messages SET user_id = 'u-does-not-exist' WHERE content = 'hayalet'`)

		got, err := repo.GetByID(ctx, msg.ID)
		if err != nil {
			t.Fatalf("GetByID on a message with a missing author: %v", err)
		}
		if got.Author != nil {
			t.Errorf("author = %+v, want nil for a missing user", got.Author)
		}
		if got.Content == nil || *got.Content != "hayalet" {
			t.Errorf("content = %v, want the message to still render", got.Content)
		}

		list, err := repo.GetByChannelID(ctx, msgChannel, "", 50)
		if err != nil {
			t.Fatalf("GetByChannelID with a missing author: %v", err)
		}
		var found bool
		for _, m := range list {
			if m.ID == msg.ID {
				found = true
				if m.Author != nil {
					t.Errorf("listing author = %+v, want nil", m.Author)
				}
			}
		}
		if !found {
			t.Error("the message vanished from the channel listing when its author went missing")
		}
	})

	t.Run("delete removes the row and is not idempotent", func(t *testing.T) {
		msg := newMessage(t, ctx, repo, msgChannel, msgAuthor, "silinecek")
		if err := repo.Delete(ctx, msg.ID); err != nil {
			t.Fatalf("Delete: %v", err)
		}
		if _, err := repo.GetByID(ctx, msg.ID); !errors.Is(err, pkg.ErrNotFound) {
			t.Errorf("message readable after delete: %v", err)
		}
		if err := repo.Delete(ctx, msg.ID); !errors.Is(err, pkg.ErrNotFound) {
			t.Errorf("second delete = %v, want ErrNotFound", err)
		}
	})

	t.Run("deleting a message cascades its attachments away", func(t *testing.T) {
		msg := newMessage(t, ctx, repo, msgChannel, msgAuthor, "ekli")
		attRepo := NewSQLiteAttachmentRepo(db.Conn)
		if err := attRepo.Create(ctx, &models.Attachment{
			MessageID: msg.ID, Filename: "a.png", FileURL: "/api/uploads/cascade_a.png",
		}); err != nil {
			t.Fatalf("attachment Create: %v", err)
		}
		if err := repo.Delete(ctx, msg.ID); err != nil {
			t.Fatalf("Delete: %v", err)
		}
		if n := countRows(t, db, `SELECT COUNT(*) FROM attachments WHERE message_id = ?`, msg.ID); n != 0 {
			t.Errorf("orphan attachments = %d, want 0", n)
		}
	})
}

// TestMessageRepo_Pagination pins the cursor contract the client's infinite
// scroll depends on: DESC order, limit honoured, `before` strictly older, and
// channel scoping (a leak here shows one channel's messages inside another).
func TestMessageRepo_Pagination(t *testing.T) {
	db := newTestDB(t)
	seedMessageWorld(t, db)
	repo := NewSQLiteMessageRepo(db.Conn)
	ctx := context.Background()

	// created_at is second-resolution, so each message gets an explicit,
	// distinct-per-second stamp instead of relying on insertion speed — this
	// keeps the ordering assertions below unambiguous. The case where
	// multiple messages DO share a second, and pagination must not lose any
	// of them, is exercised separately at the bottom of this test.
	ids := make([]string, 5)
	for i := range ids {
		m := newMessage(t, ctx, repo, msgChannel, msgAuthor, string(rune('a'+i)))
		ids[i] = m.ID
		if _, err := db.Conn.Exec(
			`UPDATE messages SET created_at = datetime('2026-01-01 00:00:0'||?) WHERE id = ?`, i, m.ID,
		); err != nil {
			t.Fatalf("stamp created_at: %v", err)
		}
	}
	newMessage(t, ctx, repo, msgOtherChannel, msgAuthor, "baska kanal")

	t.Run("newest first and scoped to the channel", func(t *testing.T) {
		got, err := repo.GetByChannelID(ctx, msgChannel, "", 50)
		if err != nil {
			t.Fatalf("GetByChannelID: %v", err)
		}
		if len(got) != 5 {
			t.Fatalf("messages = %d, want 5", len(got))
		}
		if got[0].ID != ids[4] {
			t.Errorf("first = %s, want the newest %s", got[0].ID, ids[4])
		}
		if got[len(got)-1].ID != ids[0] {
			t.Errorf("last = %s, want the oldest %s", got[len(got)-1].ID, ids[0])
		}
		for _, m := range got {
			if m.ChannelID != msgChannel {
				t.Fatalf("a message from %s leaked into %s's history", m.ChannelID, msgChannel)
			}
		}
	})

	t.Run("limit is honoured and returns the newest slice", func(t *testing.T) {
		got, err := repo.GetByChannelID(ctx, msgChannel, "", 2)
		if err != nil {
			t.Fatalf("GetByChannelID: %v", err)
		}
		if len(got) != 2 {
			t.Fatalf("messages = %d, want 2", len(got))
		}
		if got[0].ID != ids[4] || got[1].ID != ids[3] {
			t.Errorf("page = [%s %s], want the two newest [%s %s]", got[0].ID, got[1].ID, ids[4], ids[3])
		}
	})

	t.Run("before cursor is strictly older and excludes the cursor itself", func(t *testing.T) {
		got, err := repo.GetByChannelID(ctx, msgChannel, ids[2], 50)
		if err != nil {
			t.Fatalf("GetByChannelID: %v", err)
		}
		if len(got) != 2 {
			t.Fatalf("older than ids[2] = %d, want 2", len(got))
		}
		for _, m := range got {
			if m.ID == ids[2] {
				t.Error("the cursor message came back in its own page — the client would render it twice")
			}
			if m.ID == ids[3] || m.ID == ids[4] {
				t.Errorf("a newer message came back: %s", m.ID)
			}
		}
	})

	t.Run("paging past the beginning returns nothing", func(t *testing.T) {
		got, err := repo.GetByChannelID(ctx, msgChannel, ids[0], 50)
		if err != nil {
			t.Fatalf("GetByChannelID: %v", err)
		}
		if len(got) != 0 {
			t.Errorf("messages older than the oldest = %d, want 0", len(got))
		}
	})

	t.Run("unknown channel returns nothing without erroring", func(t *testing.T) {
		got, err := repo.GetByChannelID(ctx, "no-such-channel", "", 50)
		if err != nil {
			t.Fatalf("GetByChannelID: %v", err)
		}
		if len(got) != 0 {
			t.Errorf("messages = %d, want 0", len(got))
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
			m := newMessage(t, ctx, repo, msgChannel, msgAuthor, "es-"+string(rune('a'+i)))
			tieIDs[i] = m.ID
			if _, err := db.Conn.Exec(
				`UPDATE messages SET created_at = '2026-01-01 00:01:00' WHERE id = ?`, m.ID,
			); err != nil {
				t.Fatalf("stamp created_at: %v", err)
			}
		}

		page1, err := repo.GetByChannelID(ctx, msgChannel, "", 2)
		if err != nil {
			t.Fatalf("GetByChannelID page 1: %v", err)
		}
		if len(page1) != 2 {
			t.Fatalf("page 1 = %d messages, want 2", len(page1))
		}

		cursor := page1[len(page1)-1].ID
		page2, err := repo.GetByChannelID(ctx, msgChannel, cursor, 2)
		if err != nil {
			t.Fatalf("GetByChannelID page 2: %v", err)
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

// TestMessageRepo_UpdateRoutesOnEncryptionVersion is the column-routing test.
//
// Update branches on EncryptionVersion: version 0 writes `content`, version 1
// writes ciphertext/sender_device_id/e2ee_metadata. The E2EE branch used to
// touch only content+edited_at, so an edited encrypted message broadcast its
// new ciphertext over WS but persisted the old one — every reload showed the
// pre-edit blob. Both branches are pinned, in both directions (each must leave
// the OTHER representation alone).
func TestMessageRepo_UpdateRoutesOnEncryptionVersion(t *testing.T) {
	db := newTestDB(t)
	seedMessageWorld(t, db)
	repo := NewSQLiteMessageRepo(db.Conn)
	ctx := context.Background()

	t.Run("plaintext edit writes content and stamps edited_at", func(t *testing.T) {
		msg := newMessage(t, ctx, repo, msgChannel, msgAuthor, "ilk hali")
		updated := "duzeltilmis"
		msg.Content = &updated
		if err := repo.Update(ctx, msg); err != nil {
			t.Fatalf("Update: %v", err)
		}
		if msg.EditedAt == nil {
			t.Error("Update did not set EditedAt on the passed-in model")
		}

		got, err := repo.GetByID(ctx, msg.ID)
		if err != nil {
			t.Fatalf("GetByID: %v", err)
		}
		if got.Content == nil || *got.Content != updated {
			t.Errorf("content = %v, want %q", got.Content, updated)
		}
		if got.EditedAt == nil {
			t.Error("edited_at is NULL in the row after an edit")
		}
		if got.EncryptionVersion != 0 {
			t.Errorf("encryption_version = %d, want 0", got.EncryptionVersion)
		}
	})

	t.Run("E2EE edit rewrites the ciphertext, not the content column", func(t *testing.T) {
		ct := "cipher-v1"
		dev := "device-1"
		meta := `{"v":1}`
		msg := &models.Message{
			ChannelID:         msgChannel,
			UserID:            msgAuthor,
			EncryptionVersion: 1,
			Ciphertext:        &ct,
			SenderDeviceID:    &dev,
			E2EEMetadata:      &meta,
		}
		if err := repo.Create(ctx, msg); err != nil {
			t.Fatalf("Create: %v", err)
		}

		newCT := "cipher-v2"
		newMeta := `{"v":2}`
		msg.Ciphertext = &newCT
		msg.E2EEMetadata = &newMeta
		if err := repo.Update(ctx, msg); err != nil {
			t.Fatalf("Update: %v", err)
		}

		got, err := repo.GetByID(ctx, msg.ID)
		if err != nil {
			t.Fatalf("GetByID: %v", err)
		}
		if got.Ciphertext == nil || *got.Ciphertext != newCT {
			t.Fatalf("ciphertext = %v, want %q — the edit was broadcast but never persisted", got.Ciphertext, newCT)
		}
		if got.E2EEMetadata == nil || *got.E2EEMetadata != newMeta {
			t.Errorf("e2ee_metadata = %v, want %q", got.E2EEMetadata, newMeta)
		}
		if got.SenderDeviceID == nil || *got.SenderDeviceID != dev {
			t.Errorf("sender_device_id = %v, want %q", got.SenderDeviceID, dev)
		}
		if got.Content != nil {
			t.Errorf("an E2EE edit wrote plaintext into content: %q", *got.Content)
		}
		if got.EditedAt == nil {
			t.Error("edited_at is NULL after an E2EE edit")
		}
	})

	t.Run("E2EE fields survive a create/read round-trip", func(t *testing.T) {
		ct := "blob"
		dev := "dev-9"
		msg := &models.Message{
			ChannelID: msgChannel, UserID: msgAuthor,
			EncryptionVersion: 1, Ciphertext: &ct, SenderDeviceID: &dev,
		}
		if err := repo.Create(ctx, msg); err != nil {
			t.Fatalf("Create: %v", err)
		}
		got, err := repo.GetByID(ctx, msg.ID)
		if err != nil {
			t.Fatalf("GetByID: %v", err)
		}
		if got.EncryptionVersion != 1 {
			t.Errorf("encryption_version = %d, want 1", got.EncryptionVersion)
		}
		if got.Ciphertext == nil || *got.Ciphertext != ct {
			t.Errorf("ciphertext = %v, want %q", got.Ciphertext, ct)
		}
		// E2EE messages carry no plaintext at all.
		if got.Content != nil {
			t.Errorf("content = %q on an E2EE message, want NULL", *got.Content)
		}
	})

	t.Run("update of a missing message reports ErrNotFound", func(t *testing.T) {
		content := "x"
		err := repo.Update(ctx, &models.Message{ID: "nope", Content: &content})
		if !errors.Is(err, pkg.ErrNotFound) {
			t.Fatalf("err = %v, want ErrNotFound", err)
		}
	})
}

// TestMessageRepo_ReplyReference: reply_to_id intentionally has no FK, so a
// reply outlives the message it answers and degrades to an ID-only reference.
func TestMessageRepo_ReplyReference(t *testing.T) {
	db := newTestDB(t)
	seedMessageWorld(t, db)
	repo := NewSQLiteMessageRepo(db.Conn)
	ctx := context.Background()

	orig := newMessage(t, ctx, repo, msgChannel, msgAuthor, "orijinal")
	content := "cevap"
	reply := &models.Message{ChannelID: msgChannel, UserID: msgSecondUser, Content: &content, ReplyToID: &orig.ID}
	if err := repo.Create(ctx, reply); err != nil {
		t.Fatalf("Create(reply): %v", err)
	}

	t.Run("full reference while the original exists", func(t *testing.T) {
		got, err := repo.GetByID(ctx, reply.ID)
		if err != nil {
			t.Fatalf("GetByID: %v", err)
		}
		ref := got.ReferencedMessage
		if ref == nil {
			t.Fatal("referenced_message is nil on a reply")
		}
		if ref.ID != orig.ID {
			t.Errorf("ref.id = %q, want %q", ref.ID, orig.ID)
		}
		if ref.Content == nil || *ref.Content != "orijinal" {
			t.Errorf("ref.content = %v, want %q", ref.Content, "orijinal")
		}
		if ref.Author == nil || ref.Author.ID != msgAuthor {
			t.Errorf("ref.author = %+v, want %s", ref.Author, msgAuthor)
		}
	})

	t.Run("the same reference appears in the channel listing", func(t *testing.T) {
		// GetByID and GetByChannelID build the reference through different
		// scan paths; they must agree.
		list, err := repo.GetByChannelID(ctx, msgChannel, "", 50)
		if err != nil {
			t.Fatalf("GetByChannelID: %v", err)
		}
		var found *models.Message
		for i := range list {
			if list[i].ID == reply.ID {
				found = &list[i]
			}
		}
		if found == nil {
			t.Fatal("the reply is missing from the channel listing")
		}
		if found.ReferencedMessage == nil || found.ReferencedMessage.Content == nil {
			t.Fatalf("listing lost the reply reference: %+v", found.ReferencedMessage)
		}
		if *found.ReferencedMessage.Content != "orijinal" {
			t.Errorf("listing ref.content = %q, want orijinal", *found.ReferencedMessage.Content)
		}
	})

	t.Run("deleting the original leaves an id-only reference", func(t *testing.T) {
		if err := repo.Delete(ctx, orig.ID); err != nil {
			t.Fatalf("Delete: %v", err)
		}
		got, err := repo.GetByID(ctx, reply.ID)
		if err != nil {
			t.Fatalf("the reply disappeared with its original: %v", err)
		}
		ref := got.ReferencedMessage
		if ref == nil {
			t.Fatal("referenced_message went nil; the client needs the id to render 'deleted message'")
		}
		if ref.ID != orig.ID {
			t.Errorf("ref.id = %q, want %q", ref.ID, orig.ID)
		}
		if ref.Content != nil {
			t.Errorf("ref.content = %q after deletion, want nil", *ref.Content)
		}
		if ref.Author != nil {
			t.Errorf("ref.author = %+v after deletion, want nil", ref.Author)
		}
	})
}

// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION GUARD — FTS5 sync triggers used an unsupported delete form.
// Fixed by migration 073_fts5_external_content_delete.sql; these tests are the
// acceptance criteria and must keep passing.
//
// Migrations 006 → 034 → 057 kept recreating the message search triggers with
// this body:
//
//	CREATE TRIGGER messages_au AFTER UPDATE OF content ON messages
//	WHEN OLD.encryption_version = 0
//	BEGIN
//	    DELETE FROM messages_fts WHERE rowid = OLD.rowid;      -- <-- wrong
//	    INSERT INTO messages_fts(rowid, content) SELECT ...;
//	END;
//
// messages_fts / dm_messages_fts are EXTERNAL-CONTENT tables
// (content='messages'). For those, FTS5 does not store the text — a plain
// `DELETE FROM <fts>` makes it re-read the content table to work out which
// tokens to remove. Inside an AFTER UPDATE trigger the content row ALREADY
// holds the NEW text, so it removes the new tokens and leaves the old ones
// stranded in the index. SQLite's documented form for external-content
// tables passes the old text explicitly:
//
//	INSERT INTO messages_fts(messages_fts, rowid, content)
//	    VALUES('delete', OLD.rowid, OLD.content);
//
// Three observable consequences, all reproduced below:
//
//  1. Stale index — an edited message stays findable by text it no longer
//     contains. Deterministic. Editing a message to redact something does
//     not remove it from search.
//  2. SQLITE_CORRUPT_VTAB — the bogus delete drives the doclist accounting
//     negative and the first content UPDATE on a freshly migrated database
//     fails with "database disk image is malformed (267)". Reproduced 8/8.
//  3. Deleted text resurfacing on an unrelated message — see below.
//
// Both trigger pairs (messages_au and dm_messages_au) carry the same body, so
// channel and DM edits are equally affected.
//
// The DELETE-path triggers (messages_ad / dm_messages_ad) were originally
// written off here as "happen to behave, because by the time an AFTER DELETE
// trigger runs the content row is gone". That was wrong, and backwards: the
// content row being gone is exactly why the plain DELETE cannot recompute the
// tokens, so it removed nothing at all. Measured on a migrated database, the
// index entry outlived the message; SQLite then reuses the freed rowid for the
// next insert, so searching a deleted message's text returned the unrelated
// newer message that landed on that rowid. Migration 073 fixes all six
// triggers, and the delete cases are pinned below.
// ─────────────────────────────────────────────────────────────────────────────

func TestMessageRepo_FTSTriggers_KnownBug(t *testing.T) {
	t.Run("editing a message leaves its old text searchable", func(t *testing.T) {
		db := newTestDB(t)
		seedMessageWorld(t, db)
		repo := NewSQLiteMessageRepo(db.Conn)
		search := NewSQLiteSearchRepo(db.Conn)
		ctx := context.Background()

		newMessage(t, ctx, repo, msgChannel, msgAuthor, "alakasiz dolgu mesaji")
		msg := newMessage(t, ctx, repo, msgChannel, msgAuthor, "parolam hunter2 olarak ayarlandi")

		before, err := search.Search(ctx, "hunter2", "srv-1", nil, nil, 25, 0)
		if err != nil {
			t.Fatalf("search: %v", err)
		}
		if before.TotalCount != 1 {
			t.Fatalf("precondition: hits before edit = %d, want 1", before.TotalCount)
		}

		redacted := "parolami degistirdim"
		msg.Content = &redacted
		if err := repo.Update(ctx, msg); err != nil {
			t.Fatalf("Update: %v", err)
		}

		after, err := search.Search(ctx, "hunter2", "srv-1", nil, nil, 25, 0)
		if err != nil {
			t.Fatalf("search after edit: %v", err)
		}
		if after.TotalCount != 0 {
			t.Errorf("the redacted term still matches %d message(s) — the old tokens were never removed from the index",
				after.TotalCount)
		}

		// The new text must be findable, i.e. a fix must not simply stop
		// indexing edits.
		fresh, err := search.Search(ctx, "degistirdim", "srv-1", nil, nil, 25, 0)
		if err != nil {
			t.Fatalf("search new term: %v", err)
		}
		if fresh.TotalCount != 1 {
			t.Errorf("edited text is not searchable: hits = %d, want 1", fresh.TotalCount)
		}
	})

	t.Run("the first content edit on a fresh database errors", func(t *testing.T) {
		db := newTestDB(t)
		seedMessageWorld(t, db)
		repo := NewSQLiteMessageRepo(db.Conn)
		ctx := context.Background()

		msg := newMessage(t, ctx, repo, msgChannel, msgAuthor, "ilk hali")
		updated := "duzeltilmis"
		msg.Content = &updated
		if err := repo.Update(ctx, msg); err != nil {
			t.Fatalf("first edit on a fresh database failed: %v", err)
		}
	})

	// The AFTER DELETE triggers were assumed to be safe on the grounds that the
	// content row is already gone by the time they run. Measured on a migrated
	// database, that is exactly backwards: "the row is gone" is why the plain
	// DELETE cannot recompute the tokens, so it removed nothing and the entry
	// outlived the message. SQLite then hands the freed rowid to the next
	// insert, which is what makes it observable through the product's own
	// search API rather than merely as index litter.
	t.Run("deleting a message takes its text out of the index", func(t *testing.T) {
		db := newTestDB(t)
		seedMessageWorld(t, db)
		repo := NewSQLiteMessageRepo(db.Conn)
		search := NewSQLiteSearchRepo(db.Conn)
		ctx := context.Background()

		msg := newMessage(t, ctx, repo, msgChannel, msgAuthor, "silinecek gizli metin")

		if n := countRows(t, db,
			`SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH 'gizli'`); n != 1 {
			t.Fatalf("precondition: index hits before delete = %d, want 1", n)
		}

		if err := repo.Delete(ctx, msg.ID); err != nil {
			t.Fatalf("Delete: %v", err)
		}

		// Straight at the index: the JOIN in Search would hide an orphan entry
		// whose message row no longer exists.
		if n := countRows(t, db,
			`SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH 'gizli'`); n != 0 {
			t.Errorf("index still holds %d entr(ies) for a deleted message's text", n)
		}

		// Rowid reuse is what turns that litter into a wrong search result: the
		// next message inserted lands on the freed rowid and inherits the
		// deleted message's tokens.
		fresh := newMessage(t, ctx, repo, msgChannel, msgAuthor, "tamamen alakasiz")
		res, err := search.Search(ctx, "gizli", "srv-1", nil, nil, 25, 0)
		if err != nil {
			t.Fatalf("search after delete: %v", err)
		}
		if res.TotalCount != 0 {
			t.Errorf("searching a deleted message's text returned %d hit(s); first is %+v (the new message is %s)",
				res.TotalCount, res.Messages, fresh.ID)
		}

		// The replacement message must still be findable by its OWN text.
		own, err := search.Search(ctx, "alakasiz", "srv-1", nil, nil, 25, 0)
		if err != nil {
			t.Fatalf("search for the new message: %v", err)
		}
		if own.TotalCount != 1 {
			t.Errorf("the message occupying the reused rowid is not searchable: hits = %d, want 1", own.TotalCount)
		}
	})

	// The 'delete' command may only be issued for rows the _ai trigger actually
	// indexed. E2EE rows (content NULL) are deliberately unindexed, so deleting
	// one must be a no-op rather than a delete against an absent doclist —
	// which would drive the accounting negative, i.e. re-create the corruption.
	t.Run("deleting an unindexed E2EE message leaves the index intact", func(t *testing.T) {
		db := newTestDB(t)
		seedMessageWorld(t, db)
		repo := NewSQLiteMessageRepo(db.Conn)
		search := NewSQLiteSearchRepo(db.Conn)
		ctx := context.Background()

		keep := newMessage(t, ctx, repo, msgChannel, msgAuthor, "kalici duz metin")

		ct, dev := "cipher-x", "dev-x"
		enc := &models.Message{
			ChannelID: msgChannel, UserID: msgAuthor,
			EncryptionVersion: 1, Ciphertext: &ct, SenderDeviceID: &dev,
		}
		if err := repo.Create(ctx, enc); err != nil {
			t.Fatalf("Create E2EE: %v", err)
		}
		if err := repo.Delete(ctx, enc.ID); err != nil {
			t.Fatalf("Delete E2EE: %v", err)
		}

		if _, err := db.Conn.Exec(`INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')`); err != nil {
			t.Errorf("FTS integrity-check after deleting an unindexed message: %v", err)
		}

		res, err := search.Search(ctx, "kalici", "srv-1", nil, nil, 25, 0)
		if err != nil {
			t.Fatalf("search: %v", err)
		}
		if res.TotalCount != 1 {
			t.Errorf("plaintext message hits = %d, want 1 — the E2EE delete disturbed the index", res.TotalCount)
		}

		// And the index must still be writable afterwards.
		edited := "kalici duz metin duzenlendi"
		keep.Content = &edited
		if err := repo.Update(ctx, keep); err != nil {
			t.Errorf("edit after an unindexed delete: %v", err)
		}
	})
}

// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION GUARD — the author LEFT JOIN could not tolerate a NULL author.
// Fixed by widening the scan targets in sqlite_message.go / sqlite_dm.go.
//
// sqlite_message.go opens GetByID with:
//
//	// LEFT JOIN: message stays visible even if author is deleted.
//
// but the scan list used to make only the author's ID nullable:
//
//	var author models.User
//	var authorID sql.NullString
//	... Scan(..., &authorID, &author.Username, &author.DisplayName, ...)
//
// author.Username is a plain string (and so is author.Status). When the LEFT
// JOIN yields no user row, every joined column comes back NULL and the scan
// failed with
//
//	sql: Scan error on column index 12, name "username":
//	converting NULL to string is unsupported
//
// so GetByID returned an error and — because the same scan shape is used by
// scanMessage — GetByChannelID failed for the WHOLE PAGE, not just the one
// message. The nil-author branch (`if authorID.Valid`) below it was therefore
// dead code. It is live now.
//
// Reachability: messages.user_id is `REFERENCES users(id) ON DELETE CASCADE`,
// so with foreign keys enforced a message cannot outlive its author — which
// is why this has never been hit locally. But the FK pragma is set only on
// the LOCAL SQLite branch of database.New; the remote libSQL/Turso branch
// opens the connection with no pragmas at all (and the migration runner notes
// that remote libSQL rejects PRAGMA statements outright). Production runs on
// a remote Turso DSN. This repo also already ships an orphan census
// (maintenance.go) because dangling rows are a known production condition.
//
// So: either the comment was wrong and the LEFT JOIN should be an INNER JOIN,
// or the scan targets should be nullable. The tests here encode the second
// reading, which is what the surrounding code clearly intends, and the scan
// targets in sqlite_message.go / sqlite_dm.go were widened to match: a missing
// author now yields Author == nil on a message that still renders, rather than
// an error that takes the page down with it.
// ─────────────────────────────────────────────────────────────────────────────

func TestMessageRepo_NilAuthorScan_KnownBug(t *testing.T) {
	db, dbPath := newTestDBWithPath(t)
	seedMessageWorld(t, db)
	repo := NewSQLiteMessageRepo(db.Conn)
	ctx := context.Background()

	msg := newMessage(t, ctx, repo, msgChannel, msgAuthor, "yazarsiz")
	execWithoutFKs(t, dbPath,
		`UPDATE messages SET user_id = 'u-does-not-exist' WHERE content = 'yazarsiz'`)

	got, err := repo.GetByID(ctx, msg.ID)
	if err != nil {
		t.Fatalf("GetByID on a message with a missing author: %v", err)
	}
	if got.Author != nil {
		t.Errorf("author = %+v, want nil", got.Author)
	}

	list, err := repo.GetByChannelID(ctx, msgChannel, "", 50)
	if err != nil {
		t.Fatalf("one authorless message broke the whole channel page: %v", err)
	}
	if len(list) == 0 {
		t.Error("channel listing came back empty")
	}
}
