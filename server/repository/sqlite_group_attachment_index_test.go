package repository

import (
	"context"
	"database/sql"
	"testing"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

type failedAttachmentReadback struct{ database.TxQuerier }

func (q failedAttachmentReadback) QueryRowContext(ctx context.Context, _ string, _ ...any) *sql.Row {
	return q.TxQuerier.QueryRowContext(ctx, `SELECT missing_column_for_test FROM group_dm_attachments LIMIT 1`)
}

func TestGroupDMAttachmentKeyIndexRoundTrip(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	if _, err := db.Conn.Exec(`INSERT INTO users(id,username,password_hash) VALUES('attachment-owner','attachment-owner','x'),('attachment-reader','attachment-reader','x')`); err != nil {
		t.Fatal(err)
	}
	repo := NewSQLiteGroupDMRepo(wrapForRepo(db))
	if err := repo.Create(ctx, &models.GroupDM{ID: "attachment-group", OwnerID: "attachment-owner", Name: "Files", KeyEpoch: 1, CallRoomKey: "attachment-room"}, []string{"attachment-owner", "attachment-reader"}); err != nil {
		t.Fatal(err)
	}
	cipher, device, meta := "cipher", "device", "{}"
	if err := repo.CreateMessage(ctx, &models.GroupDMMessage{ID: "attachment-message", GroupID: "attachment-group", UserID: "attachment-owner", Ciphertext: &cipher, SenderDeviceID: &device, E2EEMetadata: &meta, EncryptionVersion: 1, KeyEpoch: 1}); err != nil {
		t.Fatal(err)
	}
	zero, two := 0, 2
	for _, a := range []*models.GroupDMAttachment{{ID: "a-last-key", GroupMessageID: "attachment-message", Filename: "opaque-two", FileURL: "/api/uploads/key-two", FileKeyIndex: &two}, {ID: "z-first-key", GroupMessageID: "attachment-message", Filename: "opaque-zero", FileURL: "/api/uploads/key-zero", FileKeyIndex: &zero}, {ID: "legacy-key", GroupMessageID: "attachment-message", Filename: "encrypted_1.bin", FileURL: "/api/uploads/legacy"}} {
		if err := repo.CreateAttachment(ctx, a); err != nil {
			t.Fatal(err)
		}
	}
	rows, err := repo.GetAttachments(ctx, []string{"attachment-message"})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows["attachment-message"]) != 3 {
		t.Fatal(rows)
	}
	for _, a := range rows["attachment-message"] {
		found, err := repo.GetAttachmentByFileURL(ctx, a.FileURL)
		if err != nil {
			t.Fatal(err)
		}
		if a.ID == "legacy-key" {
			if a.FileKeyIndex != nil || found.FileKeyIndex != nil {
				t.Fatal("legacy index must remain nullable")
			}
			continue
		}
		want := 0
		if a.ID == "a-last-key" {
			want = 2
		}
		if a.FileKeyIndex == nil || *a.FileKeyIndex != want || found.FileKeyIndex == nil || *found.FileKeyIndex != want {
			t.Fatalf("index lost: %+v / %+v", a, found)
		}
	}
	bad := 10
	readback := NewSQLiteGroupDMRepo(failedAttachmentReadback{wrapForRepo(db)})
	if err := readback.CreateAttachment(ctx, &models.GroupDMAttachment{ID: "readback", GroupMessageID: "attachment-message", Filename: "readback.bin", FileURL: "/api/uploads/readback", FileKeyIndex: &zero}); err != nil {
		t.Fatalf("committed attachment reported as failed after read-back error: %v", err)
	}
	if _, err := repo.GetAttachmentByFileURL(ctx, "/api/uploads/readback"); err != nil {
		t.Fatalf("committed attachment missing: %v", err)
	}
	if err := repo.CreateAttachment(ctx, &models.GroupDMAttachment{ID: "invalid", GroupMessageID: "attachment-message", Filename: "bad", FileURL: "/api/uploads/bad", FileKeyIndex: &bad}); err == nil {
		t.Fatal("out-of-range key index must fail database constraint")
	}
}
