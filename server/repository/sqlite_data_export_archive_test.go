package repository

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func TestDataExportAttachmentArchiveOwnerOpaqueBytesAndAuthorization(t *testing.T) {
	db := newTestDB(t)
	root := t.TempDir()
	uploadDir, archiveDir := filepath.Join(root, "uploads"), filepath.Join(root, "exports")
	if err := os.MkdirAll(uploadDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := EnsureDataExportStorage(uploadDir, archiveDir); err != nil {
		t.Fatal(err)
	}
	plain := []byte("owner attachment bytes")
	ciphertext := []byte{0x00, 0xff, 0x01, 0xfe, 0x80}
	if err := os.WriteFile(filepath.Join(uploadDir, "plain.bin"), plain, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(uploadDir, "cipher.bin"), ciphertext, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(uploadDir, "peer.bin"), []byte("peer secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	execSeed(t, db, []seedStmt{
		{q: `INSERT INTO users(id,username,password_hash) VALUES('archive-owner','archiveowner','x'),('archive-peer','archivepeer','x')`},
		{q: `INSERT INTO servers(id,name,owner_id) VALUES('archive-server','Archive','archive-owner')`},
		{q: `INSERT INTO channels(id,name,type,server_id) VALUES('archive-channel','general','text','archive-server')`},
		{q: `INSERT INTO messages(id,channel_id,user_id,content,encryption_version) VALUES('archive-own-message','archive-channel','archive-owner',NULL,1),('archive-peer-message','archive-channel','archive-peer','peer',0)`},
		{q: `INSERT INTO attachments(id,message_id,filename,file_url,file_size,mime_type) VALUES('archive-own-plain','archive-own-message','hello.txt','/api/uploads/plain.bin',?,'text/plain'),('archive-own-cipher','archive-own-message','secret.enc','/api/uploads/cipher.bin',?,'application/octet-stream'),('archive-peer-file','archive-peer-message','peer.txt','/api/uploads/peer.bin',?,'text/plain')`, args: []any{len(plain), len(ciphertext), len("peer secret")}},
	})
	repo := NewSQLiteDataExportRepo(wrapForRepo(db), DataExportStorageOptions{UploadDir: uploadDir, ArchiveDir: archiveDir, MaxArchiveBytes: 2 << 20, MaxTotalArchiveBytes: 4 << 20})
	job, err := repo.Create(context.Background(), &models.User{ID: "archive-owner"})
	if err != nil {
		t.Fatal(err)
	}
	job = waitForArchiveStatus(t, repo, "archive-owner", job.ID, "ready")
	if !job.AttachmentsReady {
		t.Fatal("archive was not marked ready")
	}
	file, _, err := repo.DownloadAttachments(context.Background(), "archive-owner", job.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	_ = file.Close()
	var generation string
	if err := db.Conn.QueryRow(`SELECT lease_owner FROM data_export_archive_reservations WHERE job_id=? AND state='ready'`, job.ID).Scan(&generation); err != nil {
		t.Fatal(err)
	}
	archiveFile, archiveSize, err := repo.(*sqliteDataExportRepo).openArchive(job.ID, generation)
	if err != nil {
		t.Fatal(err)
	}
	zipReader, err := zip.NewReader(archiveFile, archiveSize)
	if err != nil {
		t.Fatal(err)
	}
	entries := map[string][]byte{}
	for _, entry := range zipReader.File {
		opened, err := entry.Open()
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(opened)
		_ = opened.Close()
		if err != nil {
			t.Fatal(err)
		}
		entries[entry.Name] = data
	}
	if !(bytes.Equal(entries["files/000001.bin"], plain) && bytes.Equal(entries["files/000002.bin"], ciphertext)) && !(bytes.Equal(entries["files/000001.bin"], ciphertext) && bytes.Equal(entries["files/000002.bin"], plain)) {
		t.Fatalf("archived bytes differ: %#v", entries)
	}
	manifest := string(entries["manifest.json"])
	if !strings.Contains(manifest, "archive-own-message") || !strings.Contains(manifest, "opaque bytes") || strings.Contains(manifest, "archive-peer-message") || strings.Contains(manifest, "peer.txt") {
		t.Fatalf("manifest ownership/opacity mismatch: %s", manifest)
	}
	if _, _, err := repo.DownloadAttachments(context.Background(), "archive-peer", job.ID); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("cross-owner archive download = %v", err)
	}
	if err := archiveFile.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`UPDATE data_exports SET expires_at=datetime('now','-1 second') WHERE id=?`, job.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`UPDATE data_export_archive_reservations SET expires_at=datetime('now','-1 second') WHERE job_id=?`, job.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := repo.DownloadAttachments(context.Background(), "archive-owner", job.ID); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("expired archive download = %v", err)
	}
	if err := repo.PurgeExpired(context.Background()); err != nil {
		t.Fatal(err)
	}
	archivePath, _ := repo.(*sqliteDataExportRepo).archivePath(job.ID, generation)
	if _, err := os.Stat(archivePath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expired archive file remains: %v", err)
	}
}

func TestDataExportStorageAndUploadPathGuards(t *testing.T) {
	root := t.TempDir()
	uploads, exports := filepath.Join(root, "uploads"), filepath.Join(root, "exports")
	if err := os.MkdirAll(uploads, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := EnsureDataExportStorage(uploads, filepath.Join(uploads, "nested")); err == nil {
		t.Fatal("accepted export directory inside public upload tree")
	}
	for _, value := range []string{"https://example.invalid/file", "/api/uploads/../secret", "/api/uploads/%2e%2e/secret", "/api/uploads/a/b"} {
		if _, _, err := openOwnedUpload(uploads, value); err == nil {
			t.Fatalf("accepted unsafe attachment URL %q", value)
		}
	}
	if err := EnsureDataExportStorage(uploads, exports); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(uploads, "oversize.bin"), []byte("123456"), 0o600); err != nil {
		t.Fatal(err)
	}
	repo := &sqliteDataExportRepo{uploadDir: uploads, archiveDir: exports, maxArchiveBytes: 5}
	if _, _, err := repo.buildAttachmentArchive(context.Background(), strings.Repeat("a", 48), []exportAttachment{{ID: "oversize", FileURL: "/api/uploads/oversize.bin", FileSize: ptrInt64(6)}}, strings.Repeat("b", 48), 5); err == nil {
		t.Fatal("archive quota did not fail closed")
	}
	entries, err := os.ReadDir(exports)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("failed archive left files: %v", entries)
	}
	limited := &sqliteDataExportRepo{uploadDir: uploads, archiveDir: exports, maxArchiveBytes: 1 << 20}
	if _, _, err := limited.buildAttachmentArchive(context.Background(), strings.Repeat("c", 48), []exportAttachment{{ID: "small", Filename: strings.Repeat("escaped-\"-", 30), FileURL: "/api/uploads/oversize.bin", FileSize: ptrInt64(6)}}, strings.Repeat("d", 48), 100); !errors.Is(err, errArchiveQuota) {
		t.Fatalf("manifest/ZIP overhead escaped hard cap: %v", err)
	}
	entries, err = os.ReadDir(exports)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("hard-cap failure left archive files: %v", entries)
	}
	link := filepath.Join(uploads, "linked.bin")
	if err := os.Symlink(filepath.Join(uploads, "oversize.bin"), link); err == nil {
		if _, _, err := openOwnedUpload(uploads, "/api/uploads/linked.bin"); err == nil {
			t.Fatal("accepted symlink upload")
		}
	}
}

func TestDataExportMissingAttachmentFailsWithoutPublication(t *testing.T) {
	db := newTestDB(t)
	uploads, archives := filepath.Join(t.TempDir(), "uploads"), filepath.Join(t.TempDir(), "archives")
	if err := os.MkdirAll(uploads, 0o700); err != nil {
		t.Fatal(err)
	}
	execSeed(t, db, []seedStmt{
		{q: `INSERT INTO users(id,username,password_hash) VALUES('missing-owner','missingowner','x')`},
		{q: `INSERT INTO servers(id,name,owner_id) VALUES('missing-server','Missing','missing-owner')`},
		{q: `INSERT INTO channels(id,name,type,server_id) VALUES('missing-channel','general','text','missing-server')`},
		{q: `INSERT INTO messages(id,channel_id,user_id,content) VALUES('missing-message','missing-channel','missing-owner','body')`},
		{q: `INSERT INTO attachments(id,message_id,filename,file_url,file_size) VALUES('missing-attachment','missing-message','gone.txt','/api/uploads/gone.bin',4)`},
	})
	repo := NewSQLiteDataExportRepo(wrapForRepo(db), DataExportStorageOptions{UploadDir: uploads, ArchiveDir: archives})
	job, err := repo.Create(context.Background(), &models.User{ID: "missing-owner"})
	if err != nil {
		t.Fatalf("metadata export regressed when binary is missing: %v", err)
	}
	job = waitForArchiveStatus(t, repo, "missing-owner", job.ID, "failed")
	if job.AttachmentsError == nil || *job.AttachmentsError != "archive_unavailable" {
		t.Fatalf("missing-file error status: %+v", job)
	}
	var jobs int
	if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM data_exports WHERE user_id='missing-owner'`).Scan(&jobs); err != nil {
		t.Fatal(err)
	}
	if jobs != 1 {
		t.Fatalf("binary failure must retain the backward-compatible JSON job; found %d", jobs)
	}
	entries, err := os.ReadDir(archives)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("failed export left archive files: %v", entries)
	}
}

func TestDataExportPendingArchiveResumesAfterRepositoryRestart(t *testing.T) {
	db := newTestDB(t)
	root := t.TempDir()
	uploads, archives := filepath.Join(root, "uploads"), filepath.Join(root, "archives")
	if err := os.MkdirAll(uploads, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(uploads, "restart.bin"), []byte("restart bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	execSeed(t, db, []seedStmt{
		{q: `INSERT INTO users(id,username,password_hash) VALUES('restart-export-owner','restartowner','x')`},
		{q: `INSERT INTO servers(id,name,owner_id) VALUES('restart-export-server','Restart','restart-export-owner')`},
		{q: `INSERT INTO channels(id,name,type,server_id) VALUES('restart-export-channel','general','text','restart-export-server')`},
		{q: `INSERT INTO messages(id,channel_id,user_id,content) VALUES('restart-export-message','restart-export-channel','restart-export-owner','body')`},
		{q: `INSERT INTO attachments(id,message_id,filename,file_url,file_size) VALUES('restart-export-attachment','restart-export-message','restart.bin','/api/uploads/restart.bin',13)`},
	})
	options := DataExportStorageOptions{UploadDir: uploads, ArchiveDir: archives, MaxArchiveBytes: 1 << 20, MaxTotalArchiveBytes: 2 << 20}
	firstProcess := NewSQLiteDataExportRepo(wrapForRepo(db), options).(*sqliteDataExportRepo)
	firstProcess.workerMu.Lock()
	firstProcess.workerStopping = true
	firstProcess.workerMu.Unlock()
	job, err := firstProcess.Create(context.Background(), &models.User{ID: "restart-export-owner"})
	if err != nil {
		t.Fatal(err)
	}
	if job.AttachmentsStatus != "pending" {
		t.Fatalf("created archive status = %q, want pending", job.AttachmentsStatus)
	}
	if err := firstProcess.StopArchiveWorker(context.Background()); err != nil {
		t.Fatal(err)
	}
	// A fresh repository instance observes the durable pending record and starts
	// a worker, matching process restart recovery rather than a request retry.
	restarted := NewSQLiteDataExportRepo(wrapForRepo(db), options)
	if err := restarted.StartPendingArchives(context.Background()); err != nil {
		t.Fatal(err)
	}
	ready := waitForArchiveStatus(t, restarted, "restart-export-owner", job.ID, "ready")
	if !ready.AttachmentsReady {
		t.Fatal("restarted worker did not publish attachment archive")
	}
	stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := restarted.StopArchiveWorker(stopCtx); err != nil {
		t.Fatal(err)
	}
}

func TestDataExportStartPendingDoesNotReviveStoppedRepository(t *testing.T) {
	db := newTestDB(t)
	root := t.TempDir()
	uploads, archives := filepath.Join(root, "uploads"), filepath.Join(root, "archives")
	if err := os.MkdirAll(uploads, 0o700); err != nil {
		t.Fatal(err)
	}
	repo := NewSQLiteDataExportRepo(wrapForRepo(db), DataExportStorageOptions{UploadDir: uploads, ArchiveDir: archives}).(*sqliteDataExportRepo)
	repo.workerMu.Lock()
	repo.workerStopping = true
	repo.workerMu.Unlock()
	if err := repo.StartPendingArchives(context.Background()); err != nil {
		t.Fatal(err)
	}
	repo.workerMu.Lock()
	stopping, running := repo.workerStopping, repo.workerRunning
	repo.workerMu.Unlock()
	if !stopping || running {
		t.Fatalf("start after stop changed worker state to stopping=%v running=%v", stopping, running)
	}
}

func TestDataExportCanceledArchiveWorkerFailsClosedAndReleasesBudget(t *testing.T) {
	db := newTestDB(t)
	jobID, workerID := strings.Repeat("5", 48), strings.Repeat("6", 48)
	expires := time.Now().UTC().Add(time.Hour)
	execSeed(t, db, []seedStmt{
		{q: `INSERT INTO users(id,username,password_hash) VALUES('cancel-export-owner','cancelexport','x')`},
	})
	payload := `{"channel_attachments":[],"direct_message_attachments":[],"group_attachments":[]}`
	if _, err := db.Conn.Exec(`INSERT INTO data_exports(id,user_id,status,payload,expires_at,attachment_status) VALUES(?,?,'ready',?,?,'building')`, jobID, "cancel-export-owner", payload, expires); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`INSERT INTO data_export_archive_reservations(job_id,user_id,reserved_bytes,state,expires_at,lease_owner,lease_until) VALUES(?,?,1,'building',?,?,?)`, jobID, "cancel-export-owner", expires, workerID, expires); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`UPDATE data_export_archive_budget SET reserved_bytes=1 WHERE id=1`); err != nil {
		t.Fatal(err)
	}
	repo := &sqliteDataExportRepo{db: wrapForRepo(db), maxArchiveBytes: 1 << 20, maxTotalArchiveBytes: 1 << 20}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	repo.processPendingArchive(ctx, pendingExportArchive{id: jobID, userID: "cancel-export-owner", attachmentPayload: `[]`, workerID: workerID})
	var status, code string
	if err := db.Conn.QueryRow(`SELECT attachment_status,attachment_error FROM data_exports WHERE id=?`, jobID).Scan(&status, &code); err != nil {
		t.Fatal(err)
	}
	var reservations, budget int
	if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM data_export_archive_reservations WHERE job_id=?`, jobID).Scan(&reservations); err != nil {
		t.Fatal(err)
	}
	if err := db.Conn.QueryRow(`SELECT reserved_bytes FROM data_export_archive_budget WHERE id=1`).Scan(&budget); err != nil {
		t.Fatal(err)
	}
	if status != "failed" || code != "worker_interrupted" || reservations != 0 || budget != 0 {
		t.Fatalf("canceled worker status/error/reservations/budget = %q/%q/%d/%d", status, code, reservations, budget)
	}
}

func TestDataExportLegacyPendingArchiveWithoutInternalSnapshotFailsClosedAndReleasesBudget(t *testing.T) {
	db := newTestDB(t)
	jobID := strings.Repeat("7", 48)
	expires := time.Now().UTC().Add(time.Hour)
	execSeed(t, db, []seedStmt{{q: `INSERT INTO users(id,username,password_hash) VALUES('legacy-archive-owner','legacyarchive','x')`}})
	// Simulate a pending export created before attachment_payload existed. The
	// public payload still has attachment metadata, but the worker must not
	// reconstruct a private snapshot from the downloadable JSON document.
	legacyPayload := `{"channel_attachments":[{"id":"old-file","file_url":"/uploads/old-file"}]}`
	if _, err := db.Conn.Exec(`INSERT INTO data_exports(id,user_id,status,payload,expires_at,attachment_status) VALUES(?,?,'ready',?,?,'pending')`, jobID, "legacy-archive-owner", legacyPayload, expires); err != nil {
		t.Fatal(err)
	}
	repo := &sqliteDataExportRepo{db: wrapForRepo(db), maxTotalArchiveBytes: 1 << 20}
	job, err := repo.claimPendingArchive(context.Background())
	if err != nil || job == nil {
		t.Fatalf("claim legacy pending export = %#v, %v", job, err)
	}
	if job.attachmentPayload != "" {
		t.Fatalf("legacy internal snapshot unexpectedly populated: %q", job.attachmentPayload)
	}
	repo.processPendingArchive(context.Background(), *job)
	var status, code string
	if err := db.Conn.QueryRow(`SELECT attachment_status,attachment_error FROM data_exports WHERE id=?`, jobID).Scan(&status, &code); err != nil {
		t.Fatal(err)
	}
	var reservations, budget int
	if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM data_export_archive_reservations WHERE job_id=?`, jobID).Scan(&reservations); err != nil {
		t.Fatal(err)
	}
	if err := db.Conn.QueryRow(`SELECT reserved_bytes FROM data_export_archive_budget WHERE id=1`).Scan(&budget); err != nil {
		t.Fatal(err)
	}
	if status != "failed" || code != "snapshot_unavailable" || reservations != 0 || budget != 0 {
		t.Fatalf("legacy snapshot recovery status/error/reservations/budget = %q/%q/%d/%d", status, code, reservations, budget)
	}
}

func waitForArchiveStatus(t *testing.T, repo DataExportRepository, userID, jobID, want string) *models.DataExportJob {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		job, err := repo.Get(context.Background(), userID, jobID)
		if err != nil {
			t.Fatal(err)
		}
		if job.AttachmentsStatus == want {
			return job
		}
		time.Sleep(20 * time.Millisecond)
	}
	job, err := repo.Get(context.Background(), userID, jobID)
	if err != nil {
		t.Fatal(err)
	}
	t.Fatalf("archive status did not reach %q: %+v", want, job)
	return nil
}

func TestDataExportArchiveBudgetSerializesConcurrentReservations(t *testing.T) {
	db := newTestDB(t)
	first := &sqliteDataExportRepo{db: wrapForRepo(db), maxTotalArchiveBytes: 100}
	second := &sqliteDataExportRepo{db: wrapForRepo(db), maxTotalArchiveBytes: 100}
	start := make(chan struct{})
	results := make(chan error, 2)
	for i, repo := range []*sqliteDataExportRepo{first, second} {
		i, repo := i, repo
		go func() {
			<-start
			results <- repo.reserveArchiveBudget(context.Background(), pendingExportArchive{id: fmt.Sprintf("job-%d", i), userID: fmt.Sprintf("user-%d", i)}, "worker", 70)
		}()
	}
	close(start)
	a, b := <-results, <-results
	if (a == nil) == (b == nil) {
		t.Fatalf("expected exactly one concurrent reservation to fit: %v / %v", a, b)
	}
	var budget, reservations int
	if err := db.Conn.QueryRow(`SELECT reserved_bytes FROM data_export_archive_budget WHERE id=1`).Scan(&budget); err != nil {
		t.Fatal(err)
	}
	if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM data_export_archive_reservations`).Scan(&reservations); err != nil {
		t.Fatal(err)
	}
	if budget != 70 || reservations != 1 {
		t.Fatalf("budget/reservations = %d/%d, want 70/1", budget, reservations)
	}
	var winnerID, winnerWorker string
	if err := db.Conn.QueryRow(`SELECT job_id,lease_owner FROM data_export_archive_reservations`).Scan(&winnerID, &winnerWorker); err != nil {
		t.Fatal(err)
	}
	if err := first.releaseArchiveReservation(context.Background(), winnerID, winnerWorker); err != nil {
		t.Fatal(err)
	}
	if err := first.releaseArchiveReservation(context.Background(), winnerID, winnerWorker); err != nil {
		t.Fatal(err)
	}
	if err := db.Conn.QueryRow(`SELECT reserved_bytes FROM data_export_archive_budget WHERE id=1`).Scan(&budget); err != nil {
		t.Fatal(err)
	}
	if budget != 0 {
		t.Fatalf("duplicate release left or double-subtracted budget: %d", budget)
	}
}

func TestDataExportArchiveExpiredLeaseKeepsBudgetUntilFilesAreGone(t *testing.T) {
	db := newTestDB(t)
	archives := t.TempDir()
	jobID, workerID := strings.Repeat("a", 48), strings.Repeat("b", 48)
	tmpName := ".tmp-" + jobID + "-" + workerID + "-partial.zip"
	tmpPath := filepath.Join(archives, tmpName)
	if err := os.WriteFile(tmpPath, []byte("worker-temp-bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	repo := &sqliteDataExportRepo{db: wrapForRepo(db), archiveDir: archives, maxTotalArchiveBytes: 100}
	job := pendingExportArchive{id: jobID, userID: "crashed-owner", expiresAt: time.Now().Add(time.Hour)}
	if err := repo.reserveArchiveBudget(context.Background(), job, workerID, 50); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`UPDATE data_export_archive_reservations SET lease_until=datetime('now','-1 second') WHERE job_id=?`, jobID); err != nil {
		t.Fatal(err)
	}
	if err := repo.recoverExpiredArchiveLeases(context.Background()); err != nil {
		t.Fatal(err)
	}
	var state string
	var budget int
	if err := db.Conn.QueryRow(`SELECT state FROM data_export_archive_reservations WHERE job_id=?`, jobID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if err := db.Conn.QueryRow(`SELECT reserved_bytes FROM data_export_archive_budget WHERE id=1`).Scan(&budget); err != nil {
		t.Fatal(err)
	}
	if state != "abandoned" || budget != 50 {
		t.Fatalf("expired lease state/budget = %q/%d, want abandoned/50", state, budget)
	}
	if _, err := os.Stat(tmpPath); err != nil {
		t.Fatalf("grace-period worker file was removed: %v", err)
	}
	if _, err := db.Conn.Exec(`UPDATE data_export_archive_reservations SET expires_at=datetime('now','-1 second') WHERE job_id=?`, jobID); err != nil {
		t.Fatal(err)
	}
	if err := repo.removeStaleArchives(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(tmpPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expired worker temp remains: %v", err)
	}
	if err := db.Conn.QueryRow(`SELECT reserved_bytes FROM data_export_archive_budget WHERE id=1`).Scan(&budget); err != nil {
		t.Fatal(err)
	}
	if budget != 0 {
		t.Fatalf("cleaned abandoned worker still reserves budget: %d", budget)
	}
}

func TestDataExportArchiveRecoverySerializesWithConcurrentReservation(t *testing.T) {
	db := newTestDB(t)
	jobID, workerID := strings.Repeat("e", 48), strings.Repeat("f", 48)
	repo := &sqliteDataExportRepo{db: wrapForRepo(db), maxTotalArchiveBytes: 100}
	if err := repo.reserveArchiveBudget(context.Background(), pendingExportArchive{id: jobID, userID: "expired-user", expiresAt: time.Now().Add(time.Hour)}, workerID, 40); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`UPDATE data_export_archive_reservations SET lease_until=datetime('now','-1 second') WHERE job_id=?`, jobID); err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	recovery := make(chan error, 1)
	reservation := make(chan error, 1)
	go func() { <-start; recovery <- repo.recoverExpiredArchiveLeases(context.Background()) }()
	go func() {
		<-start
		reservation <- repo.reserveArchiveBudget(context.Background(), pendingExportArchive{id: strings.Repeat("1", 48), userID: "new-user", expiresAt: time.Now().Add(time.Hour)}, strings.Repeat("2", 48), 70)
	}()
	close(start)
	if err := <-recovery; err != nil {
		t.Fatal(err)
	}
	if err := <-reservation; !errors.Is(err, errArchiveQuota) {
		t.Fatalf("concurrent reservation = %v, want quota rejection", err)
	}
	var budget int
	var state string
	var count int
	if err := db.Conn.QueryRow(`SELECT reserved_bytes FROM data_export_archive_budget WHERE id=1`).Scan(&budget); err != nil {
		t.Fatal(err)
	}
	if err := db.Conn.QueryRow(`SELECT state FROM data_export_archive_reservations WHERE job_id=?`, jobID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM data_export_archive_reservations`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if budget != 40 || state != "abandoned" || count != 1 {
		t.Fatalf("post-recovery budget/state/reservations = %d/%q/%d, want 40/abandoned/1", budget, state, count)
	}
}

func TestDataExportArchiveStaleSnapshotCannotAbandonNewPublication(t *testing.T) {
	db := newTestDB(t)
	jobID, generation := strings.Repeat("3", 48), strings.Repeat("4", 48)
	archives := t.TempDir()
	repo := &sqliteDataExportRepo{db: wrapForRepo(db), archiveDir: archives, maxTotalArchiveBytes: 1 << 20}
	expires := time.Now().UTC().Add(time.Hour)
	execSeed(t, db, []seedStmt{
		{q: `INSERT INTO users(id,username,password_hash) VALUES('publication-race-owner','publicationrace','x')`},
	})
	if _, err := db.Conn.Exec(`INSERT INTO data_exports(id,user_id,status,payload,expires_at,attachment_status) VALUES(?,?,'ready','{}',?,'ready')`, jobID, "publication-race-owner", expires); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`INSERT INTO data_export_archive_reservations(job_id,user_id,reserved_bytes,state,expires_at,lease_owner) VALUES(?,?,25,'ready',?,?)`, jobID, "publication-race-owner", expires, generation); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Conn.Exec(`UPDATE data_export_archive_budget SET reserved_bytes=25 WHERE id=1`); err != nil {
		t.Fatal(err)
	}
	archivePath, err := repo.archivePath(jobID, generation)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(archivePath, []byte("published archive"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Simulate a cleanup candidate from an active-state snapshot taken before
	// publication committed. The atomic NOT EXISTS predicate must retain it.
	abandoned, active, err := repo.abandonOrphanedReadyArchive(context.Background(), orphanedArchive{id: jobID, generation: generation, expires: expires})
	if err != nil {
		t.Fatal(err)
	}
	if abandoned || !active {
		t.Fatalf("stale snapshot decision abandoned=%v active=%v", abandoned, active)
	}
	if err := repo.removeStaleArchives(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(archivePath); err != nil {
		t.Fatalf("published archive was removed: %v", err)
	}
	var state string
	if err := db.Conn.QueryRow(`SELECT state FROM data_export_archive_reservations WHERE job_id=?`, jobID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "ready" {
		t.Fatalf("published archive reservation state = %q, want ready", state)
	}
}

func TestPostgresArchiveRecoveryHonorsCancellationWhileBudgetRowIsLocked(t *testing.T) {
	if os.Getenv("HICHAT_TEST_POSTGRES_DSN") == "" {
		t.Skip("requires the disposable loopback PostgreSQL test database")
	}
	db := newTestDB(t)
	blocker, err := db.Conn.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback()
	if _, err := blocker.ExecContext(context.Background(), `UPDATE data_export_archive_budget SET reserved_bytes=reserved_bytes WHERE id=1`); err != nil {
		t.Fatal(err)
	}
	repo := &sqliteDataExportRepo{db: wrapForRepo(db)}
	ctx, cancel := context.WithTimeout(context.Background(), 350*time.Millisecond)
	defer cancel()
	started := time.Now()
	err = repo.recoverExpiredArchiveLeases(ctx)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("recovery under row lock = %v, want context deadline", err)
	}
	if elapsed := time.Since(started); elapsed > 3*time.Second {
		t.Fatalf("canceled recovery took %s, want bounded exit", elapsed)
	}
}

func TestDataExportArchiveReservationsSerializePerUser(t *testing.T) {
	db := newTestDB(t)
	repo := &sqliteDataExportRepo{db: wrapForRepo(db), maxTotalArchiveBytes: 100}
	if err := repo.reserveArchiveBudget(context.Background(), pendingExportArchive{id: "job-one", userID: "same-user"}, "worker-one", 20); err != nil {
		t.Fatal(err)
	}
	if err := repo.reserveArchiveBudget(context.Background(), pendingExportArchive{id: "job-two", userID: "same-user"}, "worker-two", 20); err == nil {
		t.Fatal("accepted concurrent per-user building reservation")
	}
	var budget, count int
	if err := db.Conn.QueryRow(`SELECT reserved_bytes FROM data_export_archive_budget WHERE id=1`).Scan(&budget); err != nil {
		t.Fatal(err)
	}
	if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM data_export_archive_reservations WHERE user_id='same-user'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if budget != 20 || count != 1 {
		t.Fatalf("failed reservation changed budget: %d/%d", budget, count)
	}
}

func ptrInt64(v int64) *int64 { return &v }
