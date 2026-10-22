// sqliteSavedRepo against a real local SQLite database (migration 083):
// insert shape, hydration of both reference sides, dangling-reference skip,
// keyset pagination with a caller-scoped cursor, ownership-scoped
// update/delete, and the live-delete cleanups in the message/channel repos.
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

// seedSavedWorld: two users, a server with a channel, one channel message
// by alice, and a DM channel alice<->bob with one DM message by bob.
func seedSavedWorld(t *testing.T, db *database.DB) (channelMsg *models.Message, dmMsg *models.DMMessage) {
	t.Helper()
	ctx := context.Background()
	seedDMUsers(t, db)
	execSeed(t, db, []seedStmt{
		{`INSERT INTO servers (id, name, owner_id) VALUES ('srv-saved', 'Saved Server', ?)`, []any{dmAlice}},
		{`INSERT INTO channels (id, name, type, server_id) VALUES ('chan-saved', 'genel', 'text', 'srv-saved')`, nil},
	})
	channelMsg = newMessage(t, ctx, NewSQLiteMessageRepo(db.Conn), "chan-saved", dmAlice, "channel hello")

	dmRepo := NewSQLiteDMRepo(db.Conn)
	ch := newDMChannel(t, ctx, dmRepo, dmAlice, dmBob, models.DMStatusAccepted)
	dmMsg = newDMMessage(t, ctx, dmRepo, ch.ID, dmBob, "dm hello")
	return channelMsg, dmMsg
}

func TestSavedRepo_CreateAndHydrate(t *testing.T) {
	db := newTestDB(t)
	channelMsg, dmMsg := seedSavedWorld(t, db)
	repo := NewSQLiteSavedRepo(wrapForRepo(db))
	ctx := context.Background()

	execSeed(t, db, []seedStmt{
		{`INSERT INTO attachments (id, message_id, filename, file_url) VALUES ('att-1', ?, 'a.png', '/api/uploads/x_a.png')`, []any{channelMsg.ID}},
	})

	note := "ask about this"
	s := &models.SavedMessage{UserID: dmBob, MessageID: &channelMsg.ID, Note: &note}
	if err := repo.Create(ctx, s); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if s.ID == "" {
		t.Fatal("Create did not populate the generated ID")
	}
	assertRFC3339UTC(t, "Create read-back created_at", s.CreatedAt)

	d := &models.SavedMessage{UserID: dmBob, DMMessageID: &dmMsg.ID}
	if err := repo.Create(ctx, d); err != nil {
		t.Fatalf("Create(dm): %v", err)
	}

	got, err := repo.GetByID(ctx, dmBob, s.ID)
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	if got.Note == nil || *got.Note != note {
		t.Errorf("note = %v, want %q", got.Note, note)
	}
	if got.DMMessage != nil || got.Message == nil {
		t.Fatalf("channel bookmark hydrated wrong side: message=%v dm=%v", got.Message, got.DMMessage)
	}
	m := got.Message
	if m.ID != channelMsg.ID || m.ChannelID != "chan-saved" || m.ServerID != "srv-saved" {
		t.Errorf("message ref = %+v", m)
	}
	if m.ChannelName != "genel" || m.ServerName != "Saved Server" {
		t.Errorf("channel/server names = %q/%q", m.ChannelName, m.ServerName)
	}
	if m.Content == nil || *m.Content != "channel hello" {
		t.Errorf("content = %v", m.Content)
	}
	if m.AttachmentCount != 1 {
		t.Errorf("attachment_count = %d, want 1", m.AttachmentCount)
	}
	if m.Author == nil || m.Author.ID != dmAlice || m.Author.Username != "alice" {
		t.Errorf("author = %+v, want alice", m.Author)
	}
	if m.CreatedAt.IsZero() {
		t.Error("message created_at not populated")
	}

	gotDM, err := repo.GetByID(ctx, dmBob, d.ID)
	if err != nil {
		t.Fatalf("GetByID(dm): %v", err)
	}
	if gotDM.Message != nil || gotDM.DMMessage == nil {
		t.Fatalf("dm bookmark hydrated wrong side")
	}
	if gotDM.DMMessage.ID != dmMsg.ID || gotDM.DMMessage.DMChannelID != dmMsg.DMChannelID {
		t.Errorf("dm ref = %+v", gotDM.DMMessage)
	}
	if gotDM.DMMessage.Author == nil || gotDM.DMMessage.Author.ID != dmBob {
		t.Errorf("dm author = %+v, want bob", gotDM.DMMessage.Author)
	}
	if gotDM.Note != nil {
		t.Errorf("note = %v, want nil when none was given", gotDM.Note)
	}

	// Ownership: alice cannot read bob's bookmark by id.
	if _, err := repo.GetByID(ctx, dmAlice, s.ID); !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("GetByID(foreign owner) err = %v, want ErrNotFound", err)
	}

	// FindByRef sees the bookmark for its owner only.
	if found, err := repo.FindByRef(ctx, dmBob, channelMsg.ID, ""); err != nil || found == nil || found.ID != s.ID {
		t.Errorf("FindByRef(bob) = %v, %v; want the bookmark", found, err)
	}
	if found, err := repo.FindByRef(ctx, dmAlice, channelMsg.ID, ""); err != nil || found != nil {
		t.Errorf("FindByRef(alice) = %v, %v; want nil, nil", found, err)
	}
	if found, err := repo.FindByRef(ctx, dmBob, "", dmMsg.ID); err != nil || found == nil || found.ID != d.ID {
		t.Errorf("FindByRef(dm) = %v, %v; want the dm bookmark", found, err)
	}

	// Duplicate (user, message) hits the UNIQUE constraint.
	dup := &models.SavedMessage{UserID: dmBob, MessageID: &channelMsg.ID}
	if err := repo.Create(ctx, dup); err == nil {
		t.Error("second bookmark of the same message was accepted, want UNIQUE violation")
	}

	if n, _ := repo.Count(ctx, dmBob); n != 2 {
		t.Errorf("Count(bob) = %d, want 2", n)
	}
	if n, _ := repo.Count(ctx, dmAlice); n != 0 {
		t.Errorf("Count(alice) = %d, want 0", n)
	}

	msgIDs, dmIDs, err := repo.ListIDs(ctx, dmBob)
	if err != nil {
		t.Fatalf("ListIDs: %v", err)
	}
	if len(msgIDs) != 1 || msgIDs[0] != channelMsg.ID || len(dmIDs) != 1 || dmIDs[0] != dmMsg.ID {
		t.Errorf("ListIDs = %v / %v", msgIDs, dmIDs)
	}
	emptyMsg, emptyDM, err := repo.ListIDs(ctx, dmAlice)
	if err != nil || emptyMsg == nil || emptyDM == nil || len(emptyMsg)+len(emptyDM) != 0 {
		t.Errorf("ListIDs(alice) = %v / %v (%v), want two empty non-nil slices", emptyMsg, emptyDM, err)
	}
}

// TestSavedRepo_E2EEMessageKeepsCiphertextOpaque — the bookmark view carries
// the E2EE columns exactly as the message does (content nil, ciphertext set).
func TestSavedRepo_E2EEMessageKeepsCiphertextOpaque(t *testing.T) {
	db := newTestDB(t)
	seedSavedWorld(t, db)
	msgRepo := NewSQLiteMessageRepo(db.Conn)
	repo := NewSQLiteSavedRepo(db.Conn)
	ctx := context.Background()

	ct, dev := "opaque-blob", "dev-1"
	enc := &models.Message{ChannelID: "chan-saved", UserID: dmAlice, EncryptionVersion: 1, Ciphertext: &ct, SenderDeviceID: &dev}
	if err := msgRepo.Create(ctx, enc); err != nil {
		t.Fatalf("Create(e2ee): %v", err)
	}
	s := &models.SavedMessage{UserID: dmBob, MessageID: &enc.ID}
	if err := repo.Create(ctx, s); err != nil {
		t.Fatalf("Create: %v", err)
	}
	got, err := repo.GetByID(ctx, dmBob, s.ID)
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	if got.Message.EncryptionVersion != 1 || got.Message.Content != nil {
		t.Errorf("e2ee message hydrated as plaintext: %+v", got.Message)
	}
	if got.Message.Ciphertext == nil || *got.Message.Ciphertext != ct || got.Message.SenderDeviceID == nil || *got.Message.SenderDeviceID != dev {
		t.Errorf("ciphertext/sender_device_id not carried: %+v", got.Message)
	}
}

// TestSavedRepo_DanglingReferenceIsStub — a row whose message vanished
// without the cascade firing (the Turso case) is returned as the unavailable
// stub (own columns only) so the user can still see and delete it.
func TestSavedRepo_DanglingReferenceIsStub(t *testing.T) {
	db, path := newTestDBWithPath(t)
	channelMsg, _ := seedSavedWorld(t, db)
	repo := NewSQLiteSavedRepo(db.Conn)
	ctx := context.Background()

	live := &models.SavedMessage{UserID: dmBob, MessageID: &channelMsg.ID}
	if err := repo.Create(ctx, live); err != nil {
		t.Fatalf("Create: %v", err)
	}
	execWithoutFKs(t, path,
		`INSERT INTO saved_messages (id, user_id, message_id) VALUES ('dangling', '`+dmBob+`', 'gone-message')`)

	list, err := repo.List(ctx, dmBob, "", 10)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("List = %d rows (%v), want both the live and the dangling bookmark", len(list), savedIDs(list))
	}
	for _, row := range list {
		switch row.ID {
		case live.ID:
			if row.Unavailable || row.Message == nil {
				t.Errorf("live row = %+v, want hydrated and available", row)
			}
		case "dangling":
			if !row.Unavailable || row.Message != nil || row.DMMessage != nil {
				t.Errorf("dangling row = %+v, want the unavailable stub", row)
			}
			if row.MessageID == nil || *row.MessageID != "gone-message" || row.UserID != dmBob {
				t.Errorf("dangling stub lost its own columns: %+v", row)
			}
			assertRFC3339UTC(t, "stub created_at", row.CreatedAt)
		}
	}
	stub, err := repo.GetByID(ctx, dmBob, "dangling")
	if err != nil || !stub.Unavailable {
		t.Errorf("GetByID(dangling) = (%+v, %v), want the unavailable stub", stub, err)
	}
	// The row itself is NOT deleted by a read — that is the repair job's.
	if n := countRows(t, db, `SELECT COUNT(*) FROM saved_messages WHERE id = 'dangling'`); n != 1 {
		t.Errorf("a read removed the dangling row (count %d)", n)
	}
}

func TestSavedRepo_KeysetPaginationAndCursorScope(t *testing.T) {
	db := newTestDB(t)
	seedSavedWorld(t, db)
	msgRepo := NewSQLiteMessageRepo(db.Conn)
	repo := NewSQLiteSavedRepo(db.Conn)
	ctx := context.Background()

	// Five bookmarks with explicit created_at so id order and time order
	// disagree; two share a second so the id tiebreak is exercised.
	rows := []struct{ id, createdAt string }{
		{"s-e", "2026-01-01 10:00:01"},
		{"s-d", "2026-01-01 10:00:02"},
		{"s-c", "2026-01-01 10:00:03"},
		{"s-b", "2026-01-01 10:00:03"},
		{"s-a", "2026-01-01 10:00:05"},
	}
	for _, r := range rows {
		m := newMessage(t, ctx, msgRepo, "chan-saved", dmAlice, "m-"+r.id)
		execSeed(t, db, []seedStmt{{
			`INSERT INTO saved_messages (id, user_id, message_id, created_at) VALUES (?, ?, ?, ?)`,
			[]any{r.id, dmBob, m.ID, r.createdAt},
		}})
	}
	// Alice's own bookmark, used below as a foreign cursor.
	aliceMsg := newMessage(t, ctx, msgRepo, "chan-saved", dmAlice, "alice's")
	execSeed(t, db, []seedStmt{{
		`INSERT INTO saved_messages (id, user_id, message_id, created_at) VALUES ('alice-mid', ?, ?, '2026-01-01 10:00:03')`,
		[]any{dmAlice, aliceMsg.ID},
	}})

	page1, err := repo.List(ctx, dmBob, "", 2)
	if err != nil {
		t.Fatalf("List page1: %v", err)
	}
	if got := savedIDs(page1); got != "s-a,s-c" {
		t.Fatalf("page1 = %s, want s-a,s-c (newest first, id DESC on ties)", got)
	}
	page2, err := repo.List(ctx, dmBob, "s-c", 2)
	if err != nil {
		t.Fatalf("List page2: %v", err)
	}
	if got := savedIDs(page2); got != "s-b,s-d" {
		t.Fatalf("page2 = %s, want s-b,s-d", got)
	}
	page3, err := repo.List(ctx, dmBob, "s-d", 2)
	if err != nil {
		t.Fatalf("List page3: %v", err)
	}
	if got := savedIDs(page3); got != "s-e" {
		t.Fatalf("page3 = %s, want s-e", got)
	}
	for _, r := range page1 {
		assertRFC3339UTC(t, "List created_at", r.CreatedAt)
	}

	// Foreign and unknown cursors: empty page, no error, nothing probed.
	for _, cursor := range []string{"alice-mid", "no-such-id"} {
		got, err := repo.List(ctx, dmBob, cursor, 10)
		if err != nil {
			t.Fatalf("List(cursor %q): %v", cursor, err)
		}
		if len(got) != 0 {
			t.Errorf("cursor %q returned %d rows, want 0", cursor, len(got))
		}
	}
}

func savedIDs(list []models.SavedMessage) string {
	out := ""
	for i, s := range list {
		if i > 0 {
			out += ","
		}
		out += s.ID
	}
	return out
}

func TestSavedRepo_UpdateNoteAndDeleteAreOwnerScoped(t *testing.T) {
	db := newTestDB(t)
	channelMsg, _ := seedSavedWorld(t, db)
	repo := NewSQLiteSavedRepo(db.Conn)
	ctx := context.Background()

	s := &models.SavedMessage{UserID: dmBob, MessageID: &channelMsg.ID}
	if err := repo.Create(ctx, s); err != nil {
		t.Fatalf("Create: %v", err)
	}

	note := "updated"
	if ok, err := repo.UpdateNote(ctx, dmAlice, s.ID, &note); err != nil || ok {
		t.Errorf("UpdateNote(foreign owner) = (%v, %v), want (false, nil)", ok, err)
	}
	if ok, err := repo.UpdateNote(ctx, dmBob, "nope", &note); err != nil || ok {
		t.Errorf("UpdateNote(unknown id) = (%v, %v), want (false, nil)", ok, err)
	}
	if ok, err := repo.UpdateNote(ctx, dmBob, s.ID, &note); err != nil || !ok {
		t.Fatalf("UpdateNote = (%v, %v), want (true, nil)", ok, err)
	}
	got, _ := repo.GetByID(ctx, dmBob, s.ID)
	if got.Note == nil || *got.Note != note {
		t.Errorf("note after update = %v, want %q", got.Note, note)
	}
	if ok, err := repo.UpdateNote(ctx, dmBob, s.ID, nil); err != nil || !ok {
		t.Fatalf("UpdateNote(nil) = (%v, %v)", ok, err)
	}
	got, _ = repo.GetByID(ctx, dmBob, s.ID)
	if got.Note != nil {
		t.Errorf("note after clearing = %q, want nil", *got.Note)
	}

	if ok, err := repo.Delete(ctx, dmAlice, s.ID); err != nil || ok {
		t.Errorf("Delete(foreign owner) = (%v, %v), want (false, nil)", ok, err)
	}
	if ok, err := repo.Delete(ctx, dmBob, s.ID); err != nil || !ok {
		t.Fatalf("Delete = (%v, %v), want (true, nil)", ok, err)
	}
	if ok, err := repo.Delete(ctx, dmBob, s.ID); err != nil || ok {
		t.Errorf("second Delete = (%v, %v), want (false, nil)", ok, err)
	}
}

// TestSavedRepo_LiveDeletesRemoveBookmarks — the five explicit cleanup
// points: message delete, DM message delete, channel delete, DM channel
// delete (the server cascade and hard-delete paths are covered in
// server_cascade_test.go / sqlite_user_moderation_test.go).
func TestSavedRepo_LiveDeletesRemoveBookmarks(t *testing.T) {
	ctx := context.Background()

	t.Run("message delete", func(t *testing.T) {
		db := newTestDB(t)
		channelMsg, _ := seedSavedWorld(t, db)
		repo := NewSQLiteSavedRepo(db.Conn)
		if err := repo.Create(ctx, &models.SavedMessage{UserID: dmBob, MessageID: &channelMsg.ID}); err != nil {
			t.Fatalf("Create: %v", err)
		}
		if err := NewSQLiteMessageRepo(db.Conn).Delete(ctx, channelMsg.ID); err != nil {
			t.Fatalf("message Delete: %v", err)
		}
		if n := countRows(t, db, `SELECT COUNT(*) FROM saved_messages WHERE message_id = ?`, channelMsg.ID); n != 0 {
			t.Errorf("%d bookmark(s) survived the message delete", n)
		}
	})

	t.Run("dm message delete", func(t *testing.T) {
		db := newTestDB(t)
		_, dmMsg := seedSavedWorld(t, db)
		repo := NewSQLiteSavedRepo(db.Conn)
		if err := repo.Create(ctx, &models.SavedMessage{UserID: dmBob, DMMessageID: &dmMsg.ID}); err != nil {
			t.Fatalf("Create: %v", err)
		}
		if err := NewSQLiteDMRepo(db.Conn).DeleteMessage(ctx, dmMsg.ID); err != nil {
			t.Fatalf("DeleteMessage: %v", err)
		}
		if n := countRows(t, db, `SELECT COUNT(*) FROM saved_messages WHERE dm_message_id = ?`, dmMsg.ID); n != 0 {
			t.Errorf("%d bookmark(s) survived the DM message delete", n)
		}
	})

	t.Run("channel delete", func(t *testing.T) {
		db := newTestDB(t)
		channelMsg, _ := seedSavedWorld(t, db)
		repo := NewSQLiteSavedRepo(db.Conn)
		if err := repo.Create(ctx, &models.SavedMessage{UserID: dmBob, MessageID: &channelMsg.ID}); err != nil {
			t.Fatalf("Create: %v", err)
		}
		if err := NewSQLiteChannelRepo(db.Conn).Delete(ctx, "chan-saved"); err != nil {
			t.Fatalf("channel Delete: %v", err)
		}
		if n := countRows(t, db, `SELECT COUNT(*) FROM saved_messages WHERE message_id = ?`, channelMsg.ID); n != 0 {
			t.Errorf("%d bookmark(s) survived the channel delete", n)
		}
	})

	t.Run("dm channel delete", func(t *testing.T) {
		db := newTestDB(t)
		_, dmMsg := seedSavedWorld(t, db)
		repo := NewSQLiteSavedRepo(db.Conn)
		if err := repo.Create(ctx, &models.SavedMessage{UserID: dmBob, DMMessageID: &dmMsg.ID}); err != nil {
			t.Fatalf("Create: %v", err)
		}
		if err := NewSQLiteDMRepo(db.Conn).DeleteChannel(ctx, dmMsg.DMChannelID); err != nil {
			t.Fatalf("DeleteChannel: %v", err)
		}
		if n := countRows(t, db, `SELECT COUNT(*) FROM saved_messages WHERE dm_message_id = ?`, dmMsg.ID); n != 0 {
			t.Errorf("%d bookmark(s) survived the DM channel delete", n)
		}
	})
}

// TestHardDeleteUser_RemovesSavedAndNotes — hardDeleteUserStmts covers both
// new tables: the user's own bookmarks, and notes on either side of them.
func TestHardDeleteUser_RemovesSavedAndNotes(t *testing.T) {
	db := newTestDB(t)
	channelMsg, _ := seedSavedWorld(t, db)
	ctx := context.Background()

	if err := NewSQLiteSavedRepo(db.Conn).Create(ctx, &models.SavedMessage{UserID: dmBob, MessageID: &channelMsg.ID}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	noteRepo := NewSQLiteUserNoteRepo(db.Conn)
	if _, err := noteRepo.Upsert(ctx, dmBob, dmCarol, "bob about carol"); err != nil {
		t.Fatalf("Upsert: %v", err)
	}
	if _, err := noteRepo.Upsert(ctx, dmCarol, dmBob, "carol about bob"); err != nil {
		t.Fatalf("Upsert: %v", err)
	}
	if _, err := noteRepo.Upsert(ctx, dmCarol, dmAlice, "carol about alice"); err != nil {
		t.Fatalf("Upsert: %v", err)
	}

	if err := NewSQLiteUserRepo(db.Conn).HardDeleteUser(ctx, dmBob, "admin-reassign"); err != nil {
		t.Fatalf("HardDeleteUser: %v", err)
	}

	if n := countRows(t, db, `SELECT COUNT(*) FROM saved_messages WHERE user_id = ?`, dmBob); n != 0 {
		t.Errorf("%d saved row(s) survived HardDeleteUser", n)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM user_notes WHERE owner_user_id = ? OR target_user_id = ?`, dmBob, dmBob); n != 0 {
		t.Errorf("%d user_notes row(s) naming the deleted user survived", n)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM user_notes WHERE owner_user_id = ? AND target_user_id = ?`, dmCarol, dmAlice); n != 1 {
		t.Errorf("an unrelated note was removed (count %d, want 1)", n)
	}
}

// TestDeleteAllMessagesByUser_RemovesBookmarksOfThoseMessages — the
// platform-ban "delete messages" path removes every bookmark (by any user)
// of the banned user's channel and DM messages, and nothing else.
func TestDeleteAllMessagesByUser_RemovesBookmarksOfThoseMessages(t *testing.T) {
	db := newTestDB(t)
	channelMsg, dmMsg := seedSavedWorld(t, db) // channelMsg by alice, dmMsg by bob
	ctx := context.Background()
	repo := NewSQLiteSavedRepo(db.Conn)

	bobChannelMsg := newMessage(t, ctx, NewSQLiteMessageRepo(db.Conn), "chan-saved", dmBob, "bob in channel")
	for _, s := range []*models.SavedMessage{
		{UserID: dmCarol, MessageID: &bobChannelMsg.ID}, // goes
		{UserID: dmAlice, DMMessageID: &dmMsg.ID},       // goes (bob's DM message)
		{UserID: dmCarol, MessageID: &channelMsg.ID},    // stays (alice's message)
	} {
		if err := repo.Create(ctx, s); err != nil {
			t.Fatalf("Create: %v", err)
		}
	}

	if err := NewSQLiteUserRepo(db.Conn).DeleteAllMessagesByUser(ctx, dmBob); err != nil {
		t.Fatalf("DeleteAllMessagesByUser: %v", err)
	}

	if n := countRows(t, db, `SELECT COUNT(*) FROM saved_messages WHERE message_id = ? OR dm_message_id = ?`, bobChannelMsg.ID, dmMsg.ID); n != 0 {
		t.Errorf("%d bookmark(s) of the deleted user's messages survived", n)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM saved_messages WHERE message_id = ?`, channelMsg.ID); n != 1 {
		t.Errorf("a bookmark of another user's message was removed (count %d, want 1)", n)
	}
}
