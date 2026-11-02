package services

import (
	"context"
	"errors"
	"mime/multipart"
	"net/textproto"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
)

func attachmentReceiptFixture(t *testing.T) (DMService, *dmUploadService, string, repository.DMRepository) {
	t.Helper()
	db := newDMSendTestDB(t)
	ctx := context.Background()
	for _, id := range []string{"alice", "bob"} {
		if _, err := db.Conn.Exec(`INSERT INTO users(id,username,password_hash) VALUES(?,?,'x')`, id, id); err != nil {
			t.Fatal(err)
		}
	}
	repo := repository.NewSQLiteDMRepo(db.Conn)
	ch := &models.DMChannel{User1ID: "alice", User2ID: "bob", Status: models.DMStatusAccepted}
	if err := repo.CreateChannel(ctx, ch); err != nil {
		t.Fatal(err)
	}
	svc := NewDMService(repo, repository.NewSQLiteUserRepo(db.Conn), &testutil.MockBroadcaster{}, nil, nil, nil, repository.NewSQLiteDMReadRepo(db.Conn), repository.NewSQLiteNotificationRepo(db.Conn), repository.NewDMMessageTxRunner(db.Conn))
	upload := NewDMUploadService(repo, t.TempDir(), 1024).(*dmUploadService)
	svc.SetUploadDir(upload.uploadDir)
	return svc, upload, ch.ID, repo
}
func stageReceiptFixture(t *testing.T, upload *dmUploadService, content string) *models.CreateDMMessageRequest {
	t.Helper()
	req := &models.CreateDMMessageRequest{Content: "files", ClientMessageID: "attachment-request-0001", HasFiles: true}
	for i := range 2 {
		file, err := os.CreateTemp(t.TempDir(), "source")
		if err != nil {
			t.Fatal(err)
		}
		if _, err = file.WriteString(content); err != nil {
			t.Fatal(err)
		}
		if _, err = file.Seek(0, 0); err != nil {
			t.Fatal(err)
		}
		a, digest, err := upload.Stage(context.Background(), file, &multipart.FileHeader{Filename: "same.txt", Size: int64(len(content)), Header: textproto.MIMEHeader{"Content-Type": []string{"text/plain"}}}, false)
		file.Close()
		if err != nil {
			t.Fatal(err)
		}
		a.UploadIndex = &i
		req.StagedAttachments = append(req.StagedAttachments, *a)
		req.UploadManifest = append(req.UploadManifest, *digest)
	}
	return req
}
func discardReceiptFixture(upload *dmUploadService, req *models.CreateDMMessageRequest) {
	for i := range req.StagedAttachments {
		upload.Discard(&req.StagedAttachments[i])
	}
}

func TestDMIdempotentAttachmentsConcurrentReplayKeepsOneOrderedSet(t *testing.T) {
	svc, upload, ch, repo := attachmentReceiptFixture(t)
	requests := make([]*models.CreateDMMessageRequest, 4)
	for i := range requests {
		requests[i] = stageReceiptFixture(t, upload, "same bytes")
	}
	var wg sync.WaitGroup
	ids := make(chan string, 4)
	errs := make(chan error, 4)
	for _, req := range requests {
		wg.Add(1)
		go func() {
			defer wg.Done()
			m, err := svc.SendMessage(context.Background(), "alice", ch, req)
			discardReceiptFixture(upload, req)
			if err != nil {
				errs <- err
				return
			}
			ids <- m.ID
		}()
	}
	wg.Wait()
	close(errs)
	close(ids)
	for err := range errs {
		t.Fatal(err)
	}
	unique := map[string]bool{}
	for id := range ids {
		unique[id] = true
	}
	if len(unique) != 1 {
		t.Fatalf("messages=%d", len(unique))
	}
	page, err := svc.GetMessages(context.Background(), "bob", ch, "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Messages) != 1 || len(page.Messages[0].Attachments) != 2 {
		t.Fatalf("message/attachment count: %#v", page)
	}
	assertAttachmentReceiptFiles(t, upload, page.Messages[0].Attachments)
	if _, err = repo.GetMessageByID(context.Background(), page.Messages[0].ID); err != nil {
		t.Fatal(err)
	}
}
func assertAttachmentReceiptFiles(t *testing.T, upload *dmUploadService, attachments []models.DMAttachment) {
	t.Helper()
	for i, a := range attachments {
		if a.UploadIndex == nil || *a.UploadIndex != i {
			t.Fatalf("upload order %d", i)
		}
	}
	files, err := os.ReadDir(upload.uploadDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 2 {
		t.Fatalf("committed files=%d", len(files))
	}
	for _, file := range files {
		data, err := os.ReadFile(filepath.Join(upload.uploadDir, file.Name()))
		if err != nil || string(data) != "same bytes" {
			t.Fatal("attachment bytes lost")
		}
	}
}
func TestDMIdempotentAttachmentsConflictDeletionAndFailedStage(t *testing.T) {
	svc, upload, ch, _ := attachmentReceiptFixture(t)
	ctx := context.Background()
	first := stageReceiptFixture(t, upload, "original")
	m, err := svc.SendMessage(ctx, "alice", ch, first)
	if err != nil {
		t.Fatal(err)
	}
	discardReceiptFixture(upload, first)
	changed := stageReceiptFixture(t, upload, "changed")
	_, err = svc.SendMessage(ctx, "alice", ch, changed)
	discardReceiptFixture(upload, changed)
	if !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("conflict=%v", err)
	}
	if err = svc.DeleteMessage(ctx, "alice", m.ID); err != nil {
		t.Fatal(err)
	}
	retry := stageReceiptFixture(t, upload, "original")
	_, err = svc.SendMessage(ctx, "alice", ch, retry)
	discardReceiptFixture(upload, retry)
	if !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("deletion=%v", err)
	}
	_, _, err = upload.Stage(ctx, nil, &multipart.FileHeader{Size: 1025}, false)
	if !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("oversized stage=%v", err)
	}
	page, err := svc.GetMessages(ctx, "bob", ch, "", 10)
	if err != nil || len(page.Messages) != 0 {
		t.Fatal("retry resurrected deleted attachment message")
	}
}

type attachmentFaultTx struct{ repository.DMMessageTxRunner }
type attachmentUnknownOutcomeRepo struct{ repository.DMRepository }

func (r attachmentUnknownOutcomeRepo) CreateAttachment(context.Context, *models.DMAttachment) error {
	return pkg.ErrInternal
}

func TestDMIdempotentAttachmentsUploadRetainsUnknownAutocommitBytes(t *testing.T) {
	_, upload, _, repo := attachmentReceiptFixture(t)
	upload.dmRepo = attachmentUnknownOutcomeRepo{repo}
	file, err := os.CreateTemp(t.TempDir(), "source")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, err = file.WriteString("pending"); err != nil {
		t.Fatal(err)
	}
	if _, err = file.Seek(0, 0); err != nil {
		t.Fatal(err)
	}
	_, err = upload.Upload(context.Background(), "message", file, &multipart.FileHeader{Filename: "pending.txt", Size: 7}, false)
	if err == nil {
		t.Fatal("expected ambiguous autocommit error")
	}
	files, err := os.ReadDir(upload.uploadDir)
	if err != nil || len(files) != 1 {
		t.Fatal("unknown commit bytes were deleted")
	}
	path := filepath.Join(upload.uploadDir, files[0].Name())
	old := time.Now().Add(-48 * time.Hour)
	if err = os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
	if err = upload.cleanupStagedUploads(context.Background(), time.Now().Add(-24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	files, err = os.ReadDir(upload.uploadDir)
	if err != nil || len(files) != 0 {
		t.Fatal("unreferenced bytes were not reclaimed after grace")
	}
}

type attachmentFaultNotification struct {
	repository.NotificationRepository
}

func (n attachmentFaultNotification) CreateDMMessageIfAbsent(context.Context, *models.Notification) (bool, error) {
	return false, errors.New("fixture notification failure")
}
func (r attachmentFaultTx) InTx(ctx context.Context, fn func(*repository.DMTxRepos) error) error {
	return r.DMMessageTxRunner.InTx(ctx, func(tx *repository.DMTxRepos) error {
		tx.Notification = attachmentFaultNotification{tx.Notification}
		return fn(tx)
	})
}
func TestDMIdempotentAttachmentsRollbackAndRetry(t *testing.T) {
	service, upload, ch, _ := attachmentReceiptFixture(t)
	svc := service.(*dmService)
	original := svc.txRunner
	svc.txRunner = attachmentFaultTx{original}
	req := stageReceiptFixture(t, upload, "same bytes")
	_, err := svc.SendMessage(context.Background(), "alice", ch, req)
	discardReceiptFixture(upload, req)
	if err == nil {
		t.Fatal("expected transactional failure")
	}
	page, err := svc.GetMessages(context.Background(), "bob", ch, "", 10)
	if err != nil || len(page.Messages) != 0 {
		t.Fatal("partial message survived rollback")
	}
	files, err := os.ReadDir(upload.uploadDir)
	if err != nil || len(files) != 0 {
		t.Fatal("failed staging files were retained")
	}
	svc.txRunner = original
	req = stageReceiptFixture(t, upload, "same bytes")
	m, err := svc.SendMessage(context.Background(), "alice", ch, req)
	if err != nil {
		t.Fatal(err)
	}
	discardReceiptFixture(upload, req)
	assertAttachmentReceiptFiles(t, upload, m.Attachments)
}

func TestDMIdempotentAttachmentsCleanupPreservesCommittedFreshAndUnrelatedFiles(t *testing.T) {
	svc, upload, ch, _ := attachmentReceiptFixture(t)
	ctx := context.Background()
	committed := stageReceiptFixture(t, upload, "same bytes")
	if _, err := svc.SendMessage(ctx, "alice", ch, committed); err != nil {
		t.Fatal(err)
	}
	orphan := stageReceiptFixture(t, upload, "orphan")
	fresh := stageReceiptFixture(t, upload, "fresh")
	for _, req := range []*models.CreateDMMessageRequest{committed, orphan} {
		for _, file := range req.StagedAttachments {
			path, err := pkg.SafeJoin(upload.uploadDir, strings.TrimPrefix(file.FileURL, "/api/uploads/"))
			if err != nil {
				t.Fatal(err)
			}
			old := time.Now().Add(-48 * time.Hour)
			if err = os.Chtimes(path, old, old); err != nil {
				t.Fatal(err)
			}
		}
	}
	unrelated := filepath.Join(upload.uploadDir, "unrelated.bin")
	if err := os.WriteFile(unrelated, []byte("untouched"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := upload.cleanupStagedUploads(ctx, time.Now().Add(-24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	files, err := os.ReadDir(upload.uploadDir)
	if err != nil || len(files) != 5 {
		t.Fatalf("retained files=%d err=%v", len(files), err)
	}
	for _, req := range []*models.CreateDMMessageRequest{committed, fresh} {
		for _, file := range req.StagedAttachments {
			path, _ := pkg.SafeJoin(upload.uploadDir, strings.TrimPrefix(file.FileURL, "/api/uploads/"))
			if _, err = os.Stat(path); err != nil {
				t.Fatal("live attachment removed")
			}
		}
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	stop := StartDMUploadCleanup(cancelled, upload)
	stop()
}
