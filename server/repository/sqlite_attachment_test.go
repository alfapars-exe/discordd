// sqliteAttachmentRepo against a real local SQLite database.
//
// GetByFileURL is the lookup that decides whether /api/uploads/{name} is a
// private channel attachment (permission-checked) or an anonymous public file
// (served to anyone). Its two outcomes are therefore load-bearing in opposite
// directions:
//
//	hit  → the handler gates the download on channel-read permission
//	miss → the handler serves the bytes with no auth at all
//
// A miss that should have been a hit is a public leak of a private
// attachment, so both branches — and the pkg.ErrNotFound sentinel that
// distinguishes "no such row" from "the query blew up" — are pinned here.
//
// DB harness: testdb_test.go.
package repository

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

// newAttachment stores one attachment row through the repo.
func newAttachment(t *testing.T, ctx context.Context, repo AttachmentRepository, messageID, filename, fileURL string) *models.Attachment {
	t.Helper()
	size := int64(len(filename) * 100)
	mime := "image/png"
	att := &models.Attachment{
		MessageID: messageID,
		Filename:  filename,
		FileURL:   fileURL,
		FileSize:  &size,
		MimeType:  &mime,
	}
	if err := repo.Create(ctx, att); err != nil {
		t.Fatalf("Create(%s): %v", filename, err)
	}
	return att
}

func TestAttachmentRepo_CreateAndGetByFileURL(t *testing.T) {
	db := newTestDB(t)
	seedMessageWorld(t, db)
	msgRepo := NewSQLiteMessageRepo(db.Conn)
	repo := NewSQLiteAttachmentRepo(db.Conn)
	ctx := context.Background()

	msg := newMessage(t, ctx, msgRepo, msgChannel, msgAuthor, "dosya ekli")
	const fileURL = "/api/uploads/deadbeefcafe_kedi.png"
	att := newAttachment(t, ctx, repo, msg.ID, "kedi.png", fileURL)

	t.Run("create populates the generated id and timestamp", func(t *testing.T) {
		if att.ID == "" {
			t.Error("Create did not populate the RETURNING id")
		}
		if att.CreatedAt.IsZero() {
			t.Error("Create did not populate created_at")
		}
	})

	t.Run("hit returns the row with the owning message id", func(t *testing.T) {
		got, err := repo.GetByFileURL(ctx, fileURL)
		if err != nil {
			t.Fatalf("GetByFileURL: %v", err)
		}
		// message_id is the whole point: the download handler follows it to
		// the channel and resolves permissions there.
		if got.MessageID != msg.ID {
			t.Errorf("message_id = %q, want %q", got.MessageID, msg.ID)
		}
		if got.ID != att.ID {
			t.Errorf("id = %q, want %q", got.ID, att.ID)
		}
		if got.Filename != "kedi.png" {
			t.Errorf("filename = %q, want kedi.png", got.Filename)
		}
		if got.FileURL != fileURL {
			t.Errorf("file_url = %q, want %q", got.FileURL, fileURL)
		}
		if got.FileSize == nil || *got.FileSize != *att.FileSize {
			t.Errorf("file_size = %v, want %v", got.FileSize, att.FileSize)
		}
		if got.MimeType == nil || *got.MimeType != "image/png" {
			t.Errorf("mime_type = %v, want image/png", got.MimeType)
		}
	})

	t.Run("miss returns pkg.ErrNotFound", func(t *testing.T) {
		// Specifically ErrNotFound, not a nil row or a generic error: the
		// handler branches on errors.Is(err, pkg.ErrNotFound) to decide
		// "this is not a channel attachment, keep looking". Any other error
		// must produce a 500 instead of falling through to public serving.
		got, err := repo.GetByFileURL(ctx, "/api/uploads/no-such-file.png")
		if !errors.Is(err, pkg.ErrNotFound) {
			t.Fatalf("err = %v, want pkg.ErrNotFound", err)
		}
		if got != nil {
			t.Errorf("row = %+v on a miss, want nil", got)
		}
	})

	t.Run("lookup is exact, not a prefix or suffix match", func(t *testing.T) {
		// The handler builds the lookup key by concatenating the URL path, so
		// a LIKE-style match here would let a crafted path resolve to someone
		// else's attachment row.
		for _, probe := range []string{
			fileURL + "x",
			strings.TrimSuffix(fileURL, ".png"),
			"/api/uploads/deadbeefcafe_kedi.PNG",
			"deadbeefcafe_kedi.png",
		} {
			if _, err := repo.GetByFileURL(ctx, probe); !errors.Is(err, pkg.ErrNotFound) {
				t.Errorf("probe %q resolved to a row (err = %v), want ErrNotFound", probe, err)
			}
		}
	})

	t.Run("an attachment on another message resolves to that message", func(t *testing.T) {
		other := newMessage(t, ctx, msgRepo, msgOtherChannel, msgSecondUser, "baska kanal dosyasi")
		const otherURL = "/api/uploads/00112233_gizli.png"
		newAttachment(t, ctx, repo, other.ID, "gizli.png", otherURL)

		got, err := repo.GetByFileURL(ctx, otherURL)
		if err != nil {
			t.Fatalf("GetByFileURL: %v", err)
		}
		if got.MessageID != other.ID {
			t.Errorf("message_id = %q, want %q — the handler would gate this file on the WRONG channel",
				got.MessageID, other.ID)
		}
	})
}

// TestAttachmentRepo_DuplicateFileURLRejected pins migration 072.
//
// Two attachment rows sharing a file_url would make the download handler's
// authorization decision depend on scan order: GetByFileURL takes LIMIT 1,
// so which conversation's ACL gates the file would be whichever row SQLite
// happened to return. The UNIQUE index makes that state unrepresentable — and
// the constraint must surface as an ERROR from Create, not be swallowed.
func TestAttachmentRepo_DuplicateFileURLRejected(t *testing.T) {
	db := newTestDB(t)
	seedMessageWorld(t, db)
	msgRepo := NewSQLiteMessageRepo(db.Conn)
	repo := NewSQLiteAttachmentRepo(db.Conn)
	ctx := context.Background()

	msg := newMessage(t, ctx, msgRepo, msgChannel, msgAuthor, "ilk")
	other := newMessage(t, ctx, msgRepo, msgOtherChannel, msgSecondUser, "ikinci")
	const fileURL = "/api/uploads/aabbccdd_paylasilan.png"
	newAttachment(t, ctx, repo, msg.ID, "paylasilan.png", fileURL)

	t.Run("same message, same file_url", func(t *testing.T) {
		dup := &models.Attachment{MessageID: msg.ID, Filename: "kopya.png", FileURL: fileURL}
		if err := repo.Create(ctx, dup); err == nil {
			t.Fatal("a duplicate file_url was accepted — migration 072's UNIQUE index is missing")
		}
	})

	t.Run("different message, same file_url — the dangerous one", func(t *testing.T) {
		// This is the shape that actually breaks authorization: the same file
		// claimed by two messages in two different channels.
		dup := &models.Attachment{MessageID: other.ID, Filename: "kopya.png", FileURL: fileURL}
		if err := repo.Create(ctx, dup); err == nil {
			t.Fatal("two channels were allowed to claim the same file_url")
		}
	})

	t.Run("the original row is untouched after the rejected inserts", func(t *testing.T) {
		if n := countRows(t, db, `SELECT COUNT(*) FROM attachments WHERE file_url = ?`, fileURL); n != 1 {
			t.Fatalf("rows for the file_url = %d, want exactly 1", n)
		}
		got, err := repo.GetByFileURL(ctx, fileURL)
		if err != nil {
			t.Fatalf("GetByFileURL: %v", err)
		}
		if got.MessageID != msg.ID {
			t.Errorf("message_id = %q, want the original %q", got.MessageID, msg.ID)
		}
	})

	t.Run("a distinct file_url still inserts fine", func(t *testing.T) {
		// The constraint must not be so broad that ordinary uploads fail.
		newAttachment(t, ctx, repo, other.ID, "farkli.png", "/api/uploads/eeff0011_farkli.png")
	})
}

func TestAttachmentRepo_GetByMessageIDs(t *testing.T) {
	db := newTestDB(t)
	seedMessageWorld(t, db)
	msgRepo := NewSQLiteMessageRepo(db.Conn)
	repo := NewSQLiteAttachmentRepo(db.Conn)
	ctx := context.Background()

	withTwo := newMessage(t, ctx, msgRepo, msgChannel, msgAuthor, "iki ekli")
	withOne := newMessage(t, ctx, msgRepo, msgChannel, msgAuthor, "bir ekli")
	withNone := newMessage(t, ctx, msgRepo, msgChannel, msgAuthor, "eksiz")
	elsewhere := newMessage(t, ctx, msgRepo, msgOtherChannel, msgSecondUser, "baska kanal")

	newAttachment(t, ctx, repo, withTwo.ID, "a.png", "/api/uploads/1111_a.png")
	newAttachment(t, ctx, repo, withTwo.ID, "b.png", "/api/uploads/2222_b.png")
	newAttachment(t, ctx, repo, withOne.ID, "c.png", "/api/uploads/3333_c.png")
	newAttachment(t, ctx, repo, elsewhere.ID, "d.png", "/api/uploads/4444_d.png")

	t.Run("returns a flat slice covering exactly the requested messages", func(t *testing.T) {
		// The batch loader returns a FLAT []Attachment (unlike the DM twin,
		// which returns a map) — the service groups by MessageID afterwards.
		// That shape is the contract callers are written against.
		got, err := repo.GetByMessageIDs(ctx, []string{withTwo.ID, withOne.ID, withNone.ID})
		if err != nil {
			t.Fatalf("GetByMessageIDs: %v", err)
		}
		if len(got) != 3 {
			t.Fatalf("attachments = %d, want 3 (%+v)", len(got), got)
		}

		byMessage := map[string][]string{}
		for _, a := range got {
			byMessage[a.MessageID] = append(byMessage[a.MessageID], a.Filename)
		}
		if len(byMessage[withTwo.ID]) != 2 {
			t.Errorf("attachments for withTwo = %v, want 2", byMessage[withTwo.ID])
		}
		if len(byMessage[withOne.ID]) != 1 {
			t.Errorf("attachments for withOne = %v, want 1", byMessage[withOne.ID])
		}
		if _, present := byMessage[withNone.ID]; present {
			t.Errorf("a message with no attachments produced rows: %v", byMessage[withNone.ID])
		}
		if _, present := byMessage[elsewhere.ID]; present {
			t.Errorf("an unrequested message's attachment leaked into the batch: %v", byMessage[elsewhere.ID])
		}
	})

	t.Run("single-id batch behaves like GetByMessageID", func(t *testing.T) {
		batch, err := repo.GetByMessageIDs(ctx, []string{withTwo.ID})
		if err != nil {
			t.Fatalf("GetByMessageIDs: %v", err)
		}
		single, err := repo.GetByMessageID(ctx, withTwo.ID)
		if err != nil {
			t.Fatalf("GetByMessageID: %v", err)
		}
		if len(batch) != len(single) {
			t.Fatalf("batch = %d rows, single = %d — the batched query must not change the result set",
				len(batch), len(single))
		}
		for i := range batch {
			if batch[i].ID != single[i].ID {
				t.Errorf("row %d: batch id %q != single id %q", i, batch[i].ID, single[i].ID)
			}
		}
	})

	t.Run("empty id list short-circuits to nil without touching the DB", func(t *testing.T) {
		got, err := repo.GetByMessageIDs(ctx, nil)
		if err != nil {
			t.Fatalf("GetByMessageIDs(nil): %v", err)
		}
		if len(got) != 0 {
			t.Errorf("attachments = %d, want 0", len(got))
		}
		got, err = repo.GetByMessageIDs(ctx, []string{})
		if err != nil {
			t.Fatalf("GetByMessageIDs(empty): %v", err)
		}
		if len(got) != 0 {
			t.Errorf("attachments = %d, want 0", len(got))
		}
	})

	t.Run("unknown ids return nothing without erroring", func(t *testing.T) {
		got, err := repo.GetByMessageIDs(ctx, []string{"ghost-1", "ghost-2"})
		if err != nil {
			t.Fatalf("GetByMessageIDs: %v", err)
		}
		if len(got) != 0 {
			t.Errorf("attachments = %d, want 0", len(got))
		}
	})

	t.Run("a large id list does not blow up the placeholder expansion", func(t *testing.T) {
		// The query builds one "?" per id by string repetition; an off-by-one
		// there is a syntax error at a batch size nobody tests by hand.
		ids := make([]string, 0, 64)
		ids = append(ids, withTwo.ID)
		for i := 0; i < 63; i++ {
			ids = append(ids, "ghost-"+strings.Repeat("x", i%5))
		}
		got, err := repo.GetByMessageIDs(ctx, ids)
		if err != nil {
			t.Fatalf("GetByMessageIDs with %d ids: %v", len(ids), err)
		}
		if len(got) != 2 {
			t.Errorf("attachments = %d, want 2", len(got))
		}
	})
}

func TestAttachmentRepo_Delete(t *testing.T) {
	db := newTestDB(t)
	seedMessageWorld(t, db)
	msgRepo := NewSQLiteMessageRepo(db.Conn)
	repo := NewSQLiteAttachmentRepo(db.Conn)
	ctx := context.Background()

	msg := newMessage(t, ctx, msgRepo, msgChannel, msgAuthor, "ekli")
	const fileURL = "/api/uploads/5555_silinecek.png"
	att := newAttachment(t, ctx, repo, msg.ID, "silinecek.png", fileURL)

	if err := repo.Delete(ctx, att.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	// Once the row is gone the download handler stops recognising the path as
	// a channel attachment and serves it publicly — so the FILE must be
	// removed from disk alongside the row. That coupling lives in the upload
	// service; here we just pin that the row really goes.
	if _, err := repo.GetByFileURL(ctx, fileURL); !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("attachment still resolvable after delete: %v", err)
	}
	if err := repo.Delete(ctx, att.ID); !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("second delete = %v, want ErrNotFound", err)
	}

	t.Run("deleting a freed file_url makes it insertable again", func(t *testing.T) {
		// The UNIQUE index must not turn into a permanent reservation of the
		// name after the row is removed.
		newAttachment(t, ctx, repo, msg.ID, "yeniden.png", fileURL)
	})
}
