package repository

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func TestDataExportReadyAvailabilityIsLocalAndDoesNotMutateSharedLedger(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	root := t.TempDir()
	uploads, presentDir, absentDir := filepath.Join(root, "uploads"), filepath.Join(root, "instance-a"), filepath.Join(root, "instance-b")
	if err := os.MkdirAll(uploads, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(uploads, "opaque.bin"), []byte{0, 255, 128, 1}, 0600); err != nil {
		t.Fatal(err)
	}
	execSeed(t, db, []seedStmt{
		{q: `INSERT INTO users(id,username,password_hash) VALUES('local-export-owner','localexportowner','x'),('local-export-peer','localexportpeer','x')`},
		{q: `INSERT INTO dm_channels(id,user1_id,user2_id,e2ee_enabled) VALUES('local-export-dm','local-export-owner','local-export-peer',1)`},
		{q: `INSERT INTO dm_messages(id,dm_channel_id,user_id,content,encryption_version,ciphertext) VALUES('local-export-message','local-export-dm','local-export-owner',NULL,1,'opaque-ciphertext')`},
		{q: `INSERT INTO dm_attachments(id,dm_message_id,filename,file_url,file_size,mime_type) VALUES('local-export-file','local-export-message','opaque.bin','/api/uploads/opaque.bin',4,'application/octet-stream')`},
	})
	newRepo := func(dir string) DataExportRepository {
		return NewSQLiteDataExportRepo(wrapForRepo(db), DataExportStorageOptions{UploadDir: uploads, ArchiveDir: dir, MaxArchiveBytes: 1 << 20, MaxTotalArchiveBytes: 4 << 20})
	}
	present, absent := newRepo(presentDir), newRepo(absentDir)
	t.Cleanup(func() {
		c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = present.StopArchiveWorker(c)
		_ = absent.StopArchiveWorker(c)
	})
	job, err := present.Create(ctx, &models.User{ID: "local-export-owner"})
	if err != nil {
		t.Fatal(err)
	}
	job = waitForArchiveStatus(t, present, "local-export-owner", job.ID, "ready")
	if !job.AttachmentsReady {
		t.Fatal("present ZIP not available")
	}
	snapshot := func() string {
		var status, code, state string
		var budget, amount int64
		if err := db.Conn.QueryRow(`SELECT e.attachment_status,COALESCE(e.attachment_error,''),r.state,r.reserved_bytes,b.reserved_bytes FROM data_exports e JOIN data_export_archive_reservations r ON r.job_id=e.id CROSS JOIN data_export_archive_budget b WHERE e.id=? AND b.id=1`, job.ID).Scan(&status, &code, &state, &amount, &budget); err != nil {
			t.Fatal(err)
		}
		return status + "|" + code + "|" + state + "|" + fmt.Sprint(amount, budget)
	}
	before := snapshot()
	missing, err := absent.Get(ctx, "local-export-owner", job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if missing.AttachmentsStatus != "ready" || missing.AttachmentsReady || missing.AttachmentsError == nil || *missing.AttachmentsError != "archive_file_unavailable" {
		t.Fatalf("missing local ZIP projected as available: %+v", missing)
	}
	if _, err := absent.Download(ctx, "local-export-owner", job.ID); err != nil {
		t.Fatalf("JSON export lost: %v", err)
	}
	if _, _, err := absent.DownloadAttachments(ctx, "local-export-owner", job.ID); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("missing ZIP download: %v", err)
	}
	if _, err := absent.Get(ctx, "local-export-peer", job.ID); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("peer status access: %v", err)
	}
	// A second instance still has the immutable ZIP. A local observation must
	// neither poison that instance's response nor release its reserved bytes.
	stillReady, err := present.Get(ctx, "local-export-owner", job.ID)
	if err != nil || !stillReady.AttachmentsReady || stillReady.AttachmentsError != nil {
		t.Fatalf("other instance availability changed: %+v %v", stillReady, err)
	}
	if after := snapshot(); before != after {
		t.Fatalf("local status read changed global ledger: %s -> %s", before, after)
	}
	// Restore the missing instance's storage snapshot and re-read the SAME job;
	// no server restart or global state reset is needed to regain availability.
	entries, err := os.ReadDir(presentDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(absentDir, 0700); err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if filepath.Ext(entry.Name()) != ".zip" {
			continue
		}
		data, e := os.ReadFile(filepath.Join(presentDir, entry.Name()))
		if e != nil {
			t.Fatal(e)
		}
		if e = os.WriteFile(filepath.Join(absentDir, entry.Name()), data, 0600); e != nil {
			t.Fatal(e)
		}
	}
	restored, err := absent.Get(ctx, "local-export-owner", job.ID)
	if err != nil || !restored.AttachmentsReady || restored.AttachmentsError != nil {
		t.Fatalf("restored local ZIP unavailable: %+v %v", restored, err)
	}
	if after := snapshot(); before != after {
		t.Fatal("storage restoration changed global ledger")
	}
	if _, err := db.Conn.Exec(`UPDATE users SET is_platform_banned=1 WHERE id='local-export-owner'`); err != nil {
		t.Fatal(err)
	}
	if _, err := present.Get(ctx, "local-export-owner", job.ID); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("revoked owner read: %v", err)
	}
}
