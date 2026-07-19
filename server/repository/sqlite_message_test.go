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

func seedMessageWorld(t *testing.T, db *database.DB) {
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

// newMessage creates a plaintext message through the repo.
func newMessage(t *testing.T, ctx context.Context, repo MessageRepository, channelID, userID, content string) *models.Message {
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
		t.Skip("KNOWN BUG: NULL author columns are scanned into non-nullable targets; unskip when the scan targets are fixed")

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

	// created_at is second-resolution, so stamps are set explicitly instead
	// of relying on insertion speed.
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
		// The filler messages are load-bearing, unfortunately: the FIRST
		// content UPDATE against a freshly migrated database fails outright
		// with SQLITE_CORRUPT_VTAB. That is a real defect in the FTS sync
		// triggers, reproduced and documented in
		// TestMessageRepo_FTSTriggers_KnownBug below. Seeding some history
		// first keeps THIS test about what it claims to be about (which
		// column the Update branch writes) instead of re-failing on the
		// trigger bug.
		newMessage(t, ctx, repo, msgChannel, msgAuthor, "gecmis bir")
		newMessage(t, ctx, repo, msgChannel, msgAuthor, "gecmis iki")

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
// KNOWN BUG — FTS5 sync triggers use an unsupported delete form.
//
// Migrations 006 → 034 → 057 keep recreating the message search triggers with
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
// Two observable consequences, both reproduced below:
//
//  1. Stale index — an edited message stays findable by text it no longer
//     contains. Deterministic. Editing a message to redact something does
//     not remove it from search.
//  2. SQLITE_CORRUPT_VTAB — the bogus delete drives the doclist accounting
//     negative and the first content UPDATE on a freshly migrated database
//     fails with "database disk image is malformed (267)". Reproduced 8/8.
//
// Both trigger pairs (messages_au and dm_messages_au) carry the same body, so
// channel and DM edits are equally affected. The DELETE-path triggers
// (messages_ad / dm_messages_ad) happen to behave, because by the time an
// AFTER DELETE trigger runs the content row is gone.
//
// These tests are SKIPPED, not deleted: they are the acceptance criteria for
// the fix. Remove the t.Skip lines once the migration lands.
// ─────────────────────────────────────────────────────────────────────────────

func TestMessageRepo_FTSTriggers_KnownBug(t *testing.T) {
	t.Run("editing a message leaves its old text searchable", func(t *testing.T) {
		t.Skip("KNOWN BUG: messages_au deletes from an external-content FTS table with a plain DELETE; unskip when the trigger is fixed")

		db := newTestDB(t)
		seedMessageWorld(t, db)
		repo := NewSQLiteMessageRepo(db.Conn)
		search := NewSQLiteSearchRepo(db.Conn)
		ctx := context.Background()

		newMessage(t, ctx, repo, msgChannel, msgAuthor, "alakasiz dolgu mesaji")
		msg := newMessage(t, ctx, repo, msgChannel, msgAuthor, "parolam hunter2 olarak ayarlandi")

		before, err := search.Search(ctx, "hunter2", "srv-1", nil, 25, 0)
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

		after, err := search.Search(ctx, "hunter2", "srv-1", nil, 25, 0)
		if err != nil {
			t.Fatalf("search after edit: %v", err)
		}
		if after.TotalCount != 0 {
			t.Errorf("the redacted term still matches %d message(s) — the old tokens were never removed from the index",
				after.TotalCount)
		}

		// The new text must be findable, i.e. a fix must not simply stop
		// indexing edits.
		fresh, err := search.Search(ctx, "degistirdim", "srv-1", nil, 25, 0)
		if err != nil {
			t.Fatalf("search new term: %v", err)
		}
		if fresh.TotalCount != 1 {
			t.Errorf("edited text is not searchable: hits = %d, want 1", fresh.TotalCount)
		}
	})

	t.Run("the first content edit on a fresh database errors", func(t *testing.T) {
		t.Skip("KNOWN BUG: first UPDATE OF content after migration fails with SQLITE_CORRUPT_VTAB (267); unskip when the trigger is fixed")

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
}

// ─────────────────────────────────────────────────────────────────────────────
// KNOWN BUG — the author LEFT JOIN cannot actually tolerate a NULL author.
//
// sqlite_message.go opens GetByID with:
//
//	// LEFT JOIN: message stays visible even if author is deleted.
//
// but the scan list only makes the author's ID nullable:
//
//	var author models.User
//	var authorID sql.NullString
//	... Scan(..., &authorID, &author.Username, &author.DisplayName, ...)
//
// author.Username is a plain string. When the LEFT JOIN yields no user row,
// every joined column comes back NULL and the scan fails with
//
//	sql: Scan error on column index 12, name "username":
//	converting NULL to string is unsupported
//
// so GetByID returns an error and — because the same scan shape is used by
// scanMessage — GetByChannelID fails for the WHOLE PAGE, not just the one
// message. The nil-author branch (`if authorID.Valid`) below it is therefore
// dead code today.
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
// So: either the comment is wrong and the LEFT JOIN should be an INNER JOIN,
// or the scan targets should be nullable. The test below encodes the second
// reading, which is what the surrounding code clearly intends.
// ─────────────────────────────────────────────────────────────────────────────

func TestMessageRepo_NilAuthorScan_KnownBug(t *testing.T) {
	t.Skip("KNOWN BUG: see the note above — NULL author columns are scanned into plain strings")

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
