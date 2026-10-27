package repository

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/pkg"
)

const (
	defaultMaxExportArchiveBytes int64 = 512 << 20
	maxExportAttachmentCount           = 10_000
	exportArchiveLease                 = 2 * time.Minute
	exportArchiveWorkLimit             = 15 * time.Minute
)

var exportIDPattern = regexp.MustCompile(`^[a-f0-9]{48}$`)

type exportAttachment struct {
	ID                string  `json:"id"`
	Section           string  `json:"section"`
	MessageID         string  `json:"message_id"`
	ConversationID    string  `json:"conversation_id"`
	Filename          string  `json:"filename"`
	FileURL           string  `json:"file_url"`
	FileSize          *int64  `json:"file_size"`
	MIMEType          *string `json:"mime_type"`
	CreatedAt         any     `json:"created_at"`
	EncryptionVersion int64   `json:"encryption_version"`
	FileKeyIndex      *int64  `json:"file_key_index,omitempty"`
}

func isExportAttachmentSection(name string) bool {
	switch name {
	case "channel_attachments", "direct_message_attachments", "group_attachments":
		return true
	default:
		return false
	}
}

func exportAttachmentFromRow(section string, row map[string]any) (exportAttachment, error) {
	str := func(key string) (string, error) {
		value, ok := row[key].(string)
		if !ok {
			return "", fmt.Errorf("missing %s", key)
		}
		return value, nil
	}
	id, err := str("id")
	if err != nil {
		return exportAttachment{}, err
	}
	messageKey, conversationKey := "message_id", "channel_id"
	if section == "direct_message_attachments" {
		messageKey, conversationKey = "dm_message_id", "dm_channel_id"
	} else if section == "group_attachments" {
		messageKey, conversationKey = "group_message_id", "group_id"
	}
	messageID, err := str(messageKey)
	if err != nil {
		return exportAttachment{}, err
	}
	conversationID, err := str(conversationKey)
	if err != nil {
		return exportAttachment{}, err
	}
	filename, err := str("filename")
	if err != nil {
		return exportAttachment{}, err
	}
	fileURL, err := str("file_url")
	if err != nil {
		return exportAttachment{}, err
	}
	version, err := exportInt64(row["encryption_version"])
	if err != nil {
		return exportAttachment{}, fmt.Errorf("invalid encryption version: %w", err)
	}
	attachment := exportAttachment{
		ID: id, Section: section, MessageID: messageID, ConversationID: conversationID,
		Filename: filename, FileURL: fileURL, FileSize: exportOptionalInt64(row["file_size"]),
		MIMEType: exportOptionalString(row["mime_type"]), CreatedAt: row["created_at"],
		EncryptionVersion: version,
	}
	if section == "group_attachments" {
		if v := exportOptionalInt64(row["file_key_index"]); v != nil {
			attachment.FileKeyIndex = v
		}
	}
	return attachment, nil
}

func exportOptionalString(v any) *string {
	if v == nil {
		return nil
	}
	if s, ok := v.(string); ok {
		return &s
	}
	return nil
}

func exportOptionalInt64(v any) *int64 {
	if v == nil {
		return nil
	}
	if n, err := exportInt64(v); err == nil {
		return &n
	}
	return nil
}

func exportInt64(v any) (int64, error) {
	switch n := v.(type) {
	case int64:
		return n, nil
	case int:
		return int64(n), nil
	case float64:
		return int64(n), nil
	default:
		return 0, fmt.Errorf("unexpected numeric type %T", v)
	}
}

// EnsureDataExportStorage creates a private archive directory and refuses to
// place it inside (or over) the upload tree served by the media endpoint.
func EnsureDataExportStorage(uploadDir, archiveDir string) error {
	if strings.TrimSpace(uploadDir) == "" || strings.TrimSpace(archiveDir) == "" {
		return errors.New("upload and export directories are required")
	}
	if err := os.MkdirAll(archiveDir, 0o700); err != nil {
		return fmt.Errorf("create export directory: %w", err)
	}
	info, err := os.Lstat(archiveDir)
	if err != nil {
		return fmt.Errorf("stat export directory: %w", err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("export directory must be a real directory")
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(archiveDir, 0o700); err != nil {
			return fmt.Errorf("restrict export directory permissions: %w", err)
		}
	}
	uploadAbs, err := filepath.Abs(uploadDir)
	if err != nil {
		return fmt.Errorf("resolve upload directory: %w", err)
	}
	exportAbs, err := filepath.Abs(archiveDir)
	if err != nil {
		return fmt.Errorf("resolve export directory: %w", err)
	}
	if uploadReal, e := filepath.EvalSymlinks(uploadAbs); e == nil {
		uploadAbs = uploadReal
	}
	if exportReal, e := filepath.EvalSymlinks(exportAbs); e == nil {
		exportAbs = exportReal
	}
	if pathsOverlap(uploadAbs, exportAbs) {
		return errors.New("export directory must be separate from upload directory")
	}
	return nil
}

func pathsOverlap(a, b string) bool {
	a, b = filepath.Clean(a), filepath.Clean(b)
	if a == b {
		return true
	}
	inside := func(parent, child string) bool {
		rel, err := filepath.Rel(parent, child)
		return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
	}
	return inside(a, b) || inside(b, a)
}

type exportManifest struct {
	Format     string                `json:"format"`
	ExportedAt time.Time             `json:"exported_at"`
	Files      []exportManifestEntry `json:"files"`
	Encrypted  string                `json:"encrypted_files_note"`
}

type exportManifestEntry struct {
	ID                string  `json:"id"`
	Section           string  `json:"section"`
	MessageID         string  `json:"message_id"`
	ConversationID    string  `json:"conversation_id"`
	Path              string  `json:"path"`
	Filename          string  `json:"filename"`
	FileSize          int64   `json:"file_size"`
	MIMEType          *string `json:"mime_type"`
	EncryptionVersion int64   `json:"encryption_version"`
	FileKeyIndex      *int64  `json:"file_key_index,omitempty"`
	SHA256            string  `json:"sha256"`
}

func (r *sqliteDataExportRepo) buildAttachmentArchive(ctx context.Context, jobID string, attachments []exportAttachment, generation string, byteLimit int64) (string, int64, error) {
	if len(attachments) == 0 {
		return "", 0, nil
	}
	if len(attachments) > maxExportAttachmentCount {
		return "", 0, fmt.Errorf("too many attachments for export: %w", pkg.ErrBadRequest)
	}
	if r.uploadDir == "" || r.archiveDir == "" {
		return "", 0, errors.New("binary data export storage is not configured")
	}
	if err := EnsureDataExportStorage(r.uploadDir, r.archiveDir); err != nil {
		return "", 0, err
	}
	if !exportIDPattern.MatchString(generation) {
		return "", 0, errors.New("invalid archive generation")
	}
	if byteLimit <= 0 || byteLimit > r.maxArchiveBytes {
		byteLimit = r.maxArchiveBytes
	}
	tmp, err := os.CreateTemp(r.archiveDir, ".tmp-"+jobID+"-"+generation+"-*.zip")
	if err != nil {
		return "", 0, fmt.Errorf("create export archive: %w", err)
	}
	tmpPath := tmp.Name()
	keep := false
	defer func() {
		_ = tmp.Close()
		if !keep {
			_ = os.Remove(tmpPath)
		}
	}()

	zipWriter := zip.NewWriter(&archiveLimitWriter{target: tmp, limit: byteLimit})
	manifest := exportManifest{
		Format: "hichat-attachment-archive-v1", ExportedAt: time.Now().UTC(),
		Files:     make([]exportManifestEntry, 0, len(attachments)),
		Encrypted: "Encrypted attachments are preserved as opaque bytes. Their message ciphertext and local device keys are required to decrypt them.",
	}
	var totalBytes int64
	for index, attachment := range attachments {
		if err := ctx.Err(); err != nil {
			_ = zipWriter.Close()
			return "", 0, err
		}
		source, info, err := openOwnedUpload(r.uploadDir, attachment.FileURL)
		if err != nil {
			_ = zipWriter.Close()
			return "", 0, fmt.Errorf("open attachment %s: %w", attachment.ID, err)
		}
		if attachment.FileSize != nil && info.Size() != *attachment.FileSize {
			_ = source.Close()
			_ = zipWriter.Close()
			return "", 0, fmt.Errorf("attachment %s size changed", attachment.ID)
		}
		if info.Size() < 0 || info.Size() > r.maxArchiveBytes-totalBytes {
			_ = source.Close()
			_ = zipWriter.Close()
			return "", 0, fmt.Errorf("attachment archive exceeds configured limit: %w", pkg.ErrBadRequest)
		}
		entryPath := fmt.Sprintf("files/%06d.bin", index+1)
		entry, err := zipWriter.CreateHeader(&zip.FileHeader{Name: entryPath, Method: zip.Store, Modified: time.Now().UTC()})
		if err != nil {
			_ = source.Close()
			_ = zipWriter.Close()
			return "", 0, fmt.Errorf("create archive entry: %w", err)
		}
		digest := sha256.New()
		written, copyErr := copyExportAttachment(ctx, io.MultiWriter(entry, digest), source, r.maxArchiveBytes-totalBytes)
		closeErr := source.Close()
		if copyErr != nil || closeErr != nil {
			_ = zipWriter.Close()
			return "", 0, errors.Join(copyErr, closeErr)
		}
		if written != info.Size() {
			_ = zipWriter.Close()
			return "", 0, fmt.Errorf("attachment %s changed while exporting", attachment.ID)
		}
		totalBytes += written
		manifest.Files = append(manifest.Files, exportManifestEntry{
			ID: attachment.ID, Section: attachment.Section, MessageID: attachment.MessageID,
			ConversationID: attachment.ConversationID, Path: entryPath, Filename: attachment.Filename,
			FileSize: written, MIMEType: attachment.MIMEType, EncryptionVersion: attachment.EncryptionVersion,
			FileKeyIndex: attachment.FileKeyIndex, SHA256: hex.EncodeToString(digest.Sum(nil)),
		})
	}
	manifestBytes, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		_ = zipWriter.Close()
		return "", 0, err
	}
	manifestEntry, err := zipWriter.CreateHeader(&zip.FileHeader{Name: "manifest.json", Method: zip.Store, Modified: manifest.ExportedAt})
	if err != nil {
		_ = zipWriter.Close()
		return "", 0, err
	}
	if _, err := manifestEntry.Write(manifestBytes); err != nil {
		_ = zipWriter.Close()
		return "", 0, err
	}
	if err := zipWriter.Close(); err != nil {
		return "", 0, fmt.Errorf("finalize export archive: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		return "", 0, fmt.Errorf("sync export archive: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return "", 0, fmt.Errorf("close export archive: %w", err)
	}
	archiveInfo, err := os.Stat(tmpPath)
	if err != nil {
		return "", 0, err
	}
	if archiveInfo.Size() > byteLimit {
		return "", 0, fmt.Errorf("attachment archive exceeds configured limit: %w", pkg.ErrBadRequest)
	}
	keep = true
	return tmpPath, archiveInfo.Size(), nil
}

type archiveLimitWriter struct {
	target  io.Writer
	limit   int64
	written int64
}

func (w *archiveLimitWriter) Write(p []byte) (int, error) {
	if int64(len(p)) > w.limit-w.written {
		return 0, errArchiveQuota
	}
	n, err := w.target.Write(p)
	w.written += int64(n)
	return n, err
}

func copyExportAttachment(ctx context.Context, dst io.Writer, src io.Reader, maxBytes int64) (int64, error) {
	buf := make([]byte, 64*1024)
	var total int64
	for {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		n, readErr := src.Read(buf)
		if n > 0 {
			if int64(n) > maxBytes-total {
				return total, fmt.Errorf("attachment archive exceeds configured limit: %w", pkg.ErrBadRequest)
			}
			written, err := dst.Write(buf[:n])
			total += int64(written)
			if err != nil {
				return total, err
			}
			if written != n {
				return total, io.ErrShortWrite
			}
		}
		if readErr == io.EOF {
			return total, nil
		}
		if readErr != nil {
			return total, readErr
		}
	}
}

func openOwnedUpload(uploadDir, fileURL string) (*os.File, os.FileInfo, error) {
	const prefix = "/api/uploads/"
	if !strings.HasPrefix(fileURL, prefix) {
		return nil, nil, errors.New("attachment reference is not a local upload")
	}
	name := strings.TrimPrefix(fileURL, prefix)
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, `/\\%`) || path.Clean(name) != name {
		return nil, nil, errors.New("noncanonical upload reference")
	}
	fullPath, err := pkg.SafeJoin(uploadDir, name)
	if err != nil {
		return nil, nil, errors.New("upload path is outside storage root")
	}
	before, err := os.Lstat(fullPath)
	if err != nil || !before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0 {
		return nil, nil, errors.New("upload is not a regular file")
	}
	file, err := os.Open(fullPath)
	if err != nil {
		return nil, nil, errors.New("upload is unavailable")
	}
	after, err := file.Stat()
	if err != nil || !after.Mode().IsRegular() || !os.SameFile(before, after) {
		_ = file.Close()
		return nil, nil, errors.New("upload changed during open")
	}
	return file, after, nil
}

func (r *sqliteDataExportRepo) archivePath(id, generation string) (string, error) {
	if !exportIDPattern.MatchString(id) || !exportIDPattern.MatchString(generation) || r.archiveDir == "" {
		return "", errors.New("invalid export archive id")
	}
	return filepath.Join(r.archiveDir, id+"-"+generation+".zip"), nil
}

func (r *sqliteDataExportRepo) openArchive(id, generation string) (*os.File, int64, error) {
	if r.uploadDir != "" {
		if err := EnsureDataExportStorage(r.uploadDir, r.archiveDir); err != nil {
			return nil, 0, pkg.ErrNotFound
		}
	}
	archivePath, err := r.archivePath(id, generation)
	if err != nil {
		return nil, 0, pkg.ErrNotFound
	}
	before, err := os.Lstat(archivePath)
	if err != nil || !before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0 {
		return nil, 0, pkg.ErrNotFound
	}
	file, err := os.Open(archivePath)
	if err != nil {
		return nil, 0, pkg.ErrNotFound
	}
	after, err := file.Stat()
	if err != nil || !after.Mode().IsRegular() || !os.SameFile(before, after) {
		_ = file.Close()
		return nil, 0, pkg.ErrNotFound
	}
	return file, after.Size(), nil
}

func (r *sqliteDataExportRepo) DownloadAttachments(ctx context.Context, userID, id string) (io.ReadCloser, int64, error) {
	var storedID string
	var generation string
	err := r.db.QueryRowContext(ctx, `SELECT e.id,r.lease_owner FROM data_exports e JOIN data_export_archive_reservations r ON r.job_id=e.id AND r.user_id=e.user_id AND r.state='ready' WHERE e.id=? AND e.user_id=? AND e.status='ready' AND e.attachment_status='ready' AND e.expires_at>CURRENT_TIMESTAMP AND EXISTS(SELECT 1 FROM users u WHERE u.id=e.user_id AND u.is_bot=0 AND u.deleted_at IS NULL AND u.is_platform_banned=0 AND NOT EXISTS(SELECT 1 FROM account_lifecycle l WHERE l.user_id=u.id AND l.disabled_at IS NOT NULL))`, id, userID).Scan(&storedID, &generation)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, 0, pkg.ErrNotFound
	}
	if err != nil {
		return nil, 0, err
	}
	file, size, err := r.openArchive(storedID, generation)
	return file, size, err
}

// StartPendingArchives recovers expired worker leases and queues durable work
// left pending by a prior request or process restart.
func (r *sqliteDataExportRepo) StartPendingArchives(ctx context.Context) error {
	if r.uploadDir == "" || r.archiveDir == "" {
		return nil
	}
	if err := EnsureDataExportStorage(r.uploadDir, r.archiveDir); err != nil {
		return err
	}
	cleanupCtx, cleanupCancel := context.WithTimeout(ctx, 5*time.Second)
	err := r.recoverExpiredArchiveLeases(cleanupCtx)
	cleanupCancel()
	if err != nil {
		return err
	}
	// A repository instance is stopped permanently during process shutdown.
	// The maintenance sweeper may still be finishing a pass; it must not revive
	// this worker after StopArchiveWorker has begun. A process restart creates a
	// fresh repository instance with workerStopping=false.
	r.kickArchiveWorker()
	return nil
}

func (r *sqliteDataExportRepo) kickArchiveWorker() {
	r.workerMu.Lock()
	if r.workerRunning || r.workerStopping || r.uploadDir == "" || r.archiveDir == "" {
		r.workerMu.Unlock()
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), exportArchiveWorkLimit)
	r.workerCtx, r.workerCancel, r.workerDone = ctx, cancel, make(chan struct{})
	r.workerRunning = true
	done := r.workerDone
	r.workerMu.Unlock()
	go func() {
		defer close(done)
		r.archiveWorkerLoop(ctx)
		r.workerMu.Lock()
		r.workerRunning = false
		r.workerCancel = nil
		r.workerCtx = nil
		r.workerDone = nil
		r.workerMu.Unlock()
		cancel()
		// Close the enqueue race: a Create can commit after the worker's final
		// empty query but before it clears workerRunning.
		checkCtx, checkCancel := context.WithTimeout(context.Background(), 5*time.Second)
		pending, err := r.hasPendingArchive(checkCtx)
		checkCancel()
		if err == nil && pending {
			r.kickArchiveWorker()
		}
	}()
}

func (r *sqliteDataExportRepo) StopArchiveWorker(ctx context.Context) error {
	r.workerMu.Lock()
	r.workerStopping = true
	cancel, done := r.workerCancel, r.workerDone
	r.workerMu.Unlock()
	if cancel == nil || done == nil {
		return nil
	}
	cancel()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (r *sqliteDataExportRepo) hasPendingArchive(ctx context.Context) (bool, error) {
	var one int
	err := r.db.QueryRowContext(ctx, `SELECT 1 FROM data_exports WHERE status='ready' AND attachment_status='pending' AND expires_at>CURRENT_TIMESTAMP AND NOT EXISTS(SELECT 1 FROM data_export_archive_reservations r WHERE r.user_id=data_exports.user_id AND r.state='building') AND EXISTS(SELECT 1 FROM users u WHERE u.id=data_exports.user_id AND u.is_bot=0 AND u.deleted_at IS NULL AND u.is_platform_banned=0 AND NOT EXISTS(SELECT 1 FROM account_lifecycle l WHERE l.user_id=u.id AND l.disabled_at IS NOT NULL)) LIMIT 1`).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func (r *sqliteDataExportRepo) hasBuildingArchive(ctx context.Context) (bool, error) {
	var one int
	err := r.db.QueryRowContext(ctx, `SELECT 1 FROM data_export_archive_reservations WHERE state='building' LIMIT 1`).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

type pendingExportArchive struct {
	id, userID        string
	attachmentPayload string
	workerID          string
	expiresAt         time.Time
}

func (r *sqliteDataExportRepo) claimPendingArchive(ctx context.Context) (*pendingExportArchive, error) {
	for {
		var job pendingExportArchive
		err := r.db.QueryRowContext(ctx, `SELECT id,user_id,COALESCE(attachment_payload,''),expires_at FROM data_exports WHERE status='ready' AND attachment_status='pending' AND expires_at>CURRENT_TIMESTAMP AND NOT EXISTS(SELECT 1 FROM data_export_archive_reservations r WHERE r.user_id=data_exports.user_id AND r.state='building') AND EXISTS(SELECT 1 FROM users u WHERE u.id=data_exports.user_id AND u.is_bot=0 AND u.deleted_at IS NULL AND u.is_platform_banned=0 AND NOT EXISTS(SELECT 1 FROM account_lifecycle l WHERE l.user_id=u.id AND l.disabled_at IS NOT NULL)) ORDER BY created_at,id LIMIT 1`).Scan(&job.id, &job.userID, &job.attachmentPayload, &job.expiresAt)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		workerID, err := exportID()
		if err != nil {
			return nil, err
		}
		raw := database.RawDB(r.db)
		if raw == nil {
			return nil, errors.New("archive claim requires a transactional database")
		}
		quota := false
		err = database.WithTx(ctx, raw, func(tx *sql.Tx) error {
			budget, err := tx.ExecContext(ctx, `UPDATE data_export_archive_budget SET reserved_bytes=reserved_bytes+1 WHERE id=1 AND reserved_bytes+1<=?`, r.maxTotalArchiveBytes)
			if err != nil {
				return err
			}
			changed, err := budget.RowsAffected()
			if err != nil {
				return err
			}
			if changed != 1 {
				quota = true
				return errArchiveQuota
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO data_export_archive_reservations(job_id,user_id,reserved_bytes,state,expires_at,lease_owner,lease_until) VALUES(?,?,1,'building',?,?,?)`, job.id, job.userID, job.expiresAt, workerID, time.Now().UTC().Add(exportArchiveLease)); err != nil {
				return err
			}
			result, err := tx.ExecContext(ctx, `UPDATE data_exports SET attachment_status='building',attachment_error=NULL WHERE id=? AND attachment_status='pending' AND expires_at>CURRENT_TIMESTAMP AND NOT EXISTS(SELECT 1 FROM data_export_archive_reservations r WHERE r.user_id=data_exports.user_id AND r.state='building' AND r.job_id<>data_exports.id)`, job.id)
			if err != nil {
				return err
			}
			changed, err = result.RowsAffected()
			if err != nil {
				return err
			}
			if changed != 1 {
				return pkg.ErrNotFound
			}
			return nil
		})
		if errors.Is(err, pkg.ErrNotFound) {
			continue
		}
		if quota && errors.Is(err, errArchiveQuota) {
			_, _ = r.db.ExecContext(ctx, `UPDATE data_exports SET attachment_status='failed',attachment_error='quota_exceeded' WHERE id=? AND attachment_status='pending'`, job.id)
			continue
		}
		if err != nil {
			return nil, err
		}
		job.workerID = workerID
		return &job, nil
	}
}

func (r *sqliteDataExportRepo) archiveWorkerLoop(ctx context.Context) {
	for ctx.Err() == nil {
		job, err := r.claimPendingArchive(ctx)
		if err != nil {
			return
		}
		if job == nil {
			building, err := r.hasBuildingArchive(ctx)
			if err != nil || !building {
				return
			}
			timer := time.NewTimer(30 * time.Second)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
				cleanupCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
				_ = r.recoverExpiredArchiveLeases(cleanupCtx)
				cancel()
			}
			continue
		}
		r.processPendingArchive(ctx, *job)
	}
}

func (r *sqliteDataExportRepo) processPendingArchive(workerCtx context.Context, job pendingExportArchive) {
	ctx, cancel := context.WithCancel(workerCtx)
	defer cancel()
	keepReservation := false
	defer func() {
		if !keepReservation {
			cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_ = r.releaseArchiveReservation(cleanupCtx, job.id, job.workerID)
			cancel()
		}
	}()
	heartbeatDone := make(chan struct{})
	go r.heartbeatArchiveLease(ctx, cancel, job.id, job.workerID, heartbeatDone)
	defer close(heartbeatDone)
	if ctx.Err() != nil {
		r.failArchive(job.id, job.workerID, "worker_interrupted")
		return
	}
	var attachments []exportAttachment
	if job.attachmentPayload == "" {
		r.failArchive(job.id, job.workerID, "snapshot_unavailable")
		return
	}
	if err := json.Unmarshal([]byte(job.attachmentPayload), &attachments); err != nil || len(attachments) == 0 {
		r.failArchive(job.id, job.workerID, "invalid_snapshot")
		return
	}
	if len(attachments) > maxExportAttachmentCount {
		r.failArchive(job.id, job.workerID, "too_many_attachments")
		return
	}
	reservation, err := r.estimateAndReserve(ctx, job, job.workerID, attachments)
	if err != nil {
		code := "archive_unavailable"
		if errors.Is(err, errArchiveQuota) {
			code = "quota_exceeded"
		}
		if ctx.Err() != nil {
			code = "worker_interrupted"
		}
		r.failArchive(job.id, job.workerID, code)
		return
	}
	archivePath, archiveSize, err := r.buildAttachmentArchive(ctx, job.id, attachments, job.workerID, reservation)
	if err != nil {
		r.failArchive(job.id, job.workerID, "archive_failed")
		return
	}
	if archivePath == "" { // Snapshot was empty despite the pending marker.
		r.failArchive(job.id, job.workerID, "invalid_snapshot")
		return
	}
	if err := r.publishArchive(ctx, job, job.workerID, archivePath, archiveSize, reservation); err != nil {
		// A commit error after rename has an ambiguous outcome. Keep the final
		// file and reservation for lease recovery rather than risk unaccounted
		// bytes or a ready row with a missing archive.
		if !errors.Is(err, errArchiveCommitAmbiguous) {
			if finalPath, pathErr := r.archivePath(job.id, job.workerID); pathErr == nil {
				_ = os.Remove(finalPath)
			}
			_ = os.Remove(archivePath)
			r.failArchive(job.id, job.workerID, "archive_failed")
		} else {
			keepReservation = true
		}
		return
	}
	keepReservation = true
}

var errArchiveQuota = errors.New("attachment archive quota exceeded")
var errArchiveCommitAmbiguous = errors.New("attachment archive commit outcome ambiguous")

type orphanedArchive struct {
	id, generation string
	expires        time.Time
}

func (r *sqliteDataExportRepo) estimateAndReserve(ctx context.Context, job pendingExportArchive, workerID string, attachments []exportAttachment) (int64, error) {
	var total int64
	manifest := exportManifest{Format: "hichat-attachment-archive-v1", ExportedAt: time.Now().UTC(), Files: make([]exportManifestEntry, 0, len(attachments)), Encrypted: "Encrypted attachments are preserved as opaque bytes. Their message ciphertext and local device keys are required to decrypt them."}
	for index, attachment := range attachments {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		file, info, err := openOwnedUpload(r.uploadDir, attachment.FileURL)
		if err != nil {
			return 0, err
		}
		_ = file.Close()
		if info.Size() < 0 || (attachment.FileSize != nil && info.Size() != *attachment.FileSize) {
			return 0, errors.New("attachment size mismatch")
		}
		if info.Size() > r.maxArchiveBytes-total {
			return 0, errArchiveQuota
		}
		total += info.Size()
		manifest.Files = append(manifest.Files, exportManifestEntry{ID: attachment.ID, Section: attachment.Section, MessageID: attachment.MessageID, ConversationID: attachment.ConversationID, Path: fmt.Sprintf("files/%06d.bin", index+1), Filename: attachment.Filename, FileSize: info.Size(), MIMEType: attachment.MIMEType, EncryptionVersion: attachment.EncryptionVersion, FileKeyIndex: attachment.FileKeyIndex, SHA256: strings.Repeat("0", 64)})
	}
	manifestBytes, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return 0, err
	}
	// Measure the manifest exactly with fixed-width digest placeholders. Reserve
	// conservative ZIP record overhead, then hard-cap the archive writer at it.
	reserve := total + int64(len(manifestBytes)) + int64(len(attachments)+1)*256 + (64 << 10)
	if reserve <= 0 {
		reserve = 1
	}
	if reserve > r.maxArchiveBytes {
		return 0, errArchiveQuota
	}
	if err := r.reserveArchiveBudget(ctx, job, workerID, reserve); err != nil {
		return 0, err
	}
	return reserve, nil
}

func (r *sqliteDataExportRepo) reserveArchiveBudget(ctx context.Context, job pendingExportArchive, workerID string, amount int64) error {
	raw := database.RawDB(r.db)
	if raw == nil {
		return errors.New("archive reservation requires a transactional database")
	}
	return database.WithTx(ctx, raw, func(tx *sql.Tx) error {
		// Keep the global ledger as the first lock in every reservation mutation.
		if _, err := tx.ExecContext(ctx, `UPDATE data_export_archive_budget SET reserved_bytes=reserved_bytes WHERE id=1`); err != nil {
			return err
		}
		var previous int64
		lookupErr := tx.QueryRowContext(ctx, `SELECT reserved_bytes FROM data_export_archive_reservations WHERE job_id=? AND user_id=? AND state='building' AND lease_owner=?`, job.id, job.userID, workerID).Scan(&previous)
		if lookupErr != nil && !errors.Is(lookupErr, sql.ErrNoRows) {
			return lookupErr
		}
		delta := amount - previous
		result, err := tx.ExecContext(ctx, `UPDATE data_export_archive_budget SET reserved_bytes=reserved_bytes+? WHERE id=1 AND reserved_bytes+?>=0 AND reserved_bytes+?<=?`, delta, delta, delta, r.maxTotalArchiveBytes)
		if err != nil {
			return err
		}
		changed, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if changed != 1 {
			return errArchiveQuota
		}
		if errors.Is(lookupErr, sql.ErrNoRows) {
			_, err = tx.ExecContext(ctx, `INSERT INTO data_export_archive_reservations(job_id,user_id,reserved_bytes,state,expires_at,lease_owner,lease_until) VALUES(?,?,?,'building',?,?,?)`, job.id, job.userID, amount, job.expiresAt, workerID, time.Now().UTC().Add(exportArchiveLease))
			return err
		}
		result, err = tx.ExecContext(ctx, `UPDATE data_export_archive_reservations SET reserved_bytes=?,lease_until=? WHERE job_id=? AND user_id=? AND state='building' AND lease_owner=?`, amount, time.Now().UTC().Add(exportArchiveLease), job.id, job.userID, workerID)
		if err != nil {
			return err
		}
		changed, err = result.RowsAffected()
		if err != nil {
			return err
		}
		if changed != 1 {
			return pkg.ErrNotFound
		}
		return nil
	})
}

func (r *sqliteDataExportRepo) heartbeatArchiveLease(ctx context.Context, cancel context.CancelFunc, jobID, workerID string, done <-chan struct{}) {
	ticker := time.NewTicker(exportArchiveLease / 3)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-ctx.Done():
			return
		case <-ticker.C:
			result, err := r.db.ExecContext(ctx, `UPDATE data_export_archive_reservations SET lease_until=? WHERE job_id=? AND lease_owner=? AND state='building'`, time.Now().UTC().Add(exportArchiveLease), jobID, workerID)
			if err != nil {
				cancel()
				return
			}
			changed, err := result.RowsAffected()
			if err != nil || changed != 1 {
				cancel()
				return
			}
		}
	}
}

func (r *sqliteDataExportRepo) publishArchive(ctx context.Context, job pendingExportArchive, workerID, tempPath string, archiveSize, reserved int64) error {
	raw := database.RawDB(r.db)
	if raw == nil {
		return errors.New("archive publication requires a transactional database")
	}
	finalPath, err := r.archivePath(job.id, workerID)
	if err != nil {
		return err
	}
	var renamed, callbackSucceeded bool
	err = database.WithTx(ctx, raw, func(tx *sql.Tx) error {
		var currentStatus string
		if err := tx.QueryRowContext(ctx, `SELECT attachment_status FROM data_exports WHERE id=? AND user_id=? AND expires_at>CURRENT_TIMESTAMP`, job.id, job.userID).Scan(&currentStatus); err != nil {
			return err
		}
		if currentStatus != "building" {
			return pkg.ErrNotFound
		}
		result, err := tx.ExecContext(ctx, `UPDATE data_export_archive_budget SET reserved_bytes=reserved_bytes-?+? WHERE id=1 AND reserved_bytes>=? AND reserved_bytes-?+?<=?`, reserved, archiveSize, reserved, reserved, archiveSize, r.maxTotalArchiveBytes)
		if err != nil {
			return err
		}
		changed, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if changed != 1 {
			return errArchiveQuota
		}
		res, err := tx.ExecContext(ctx, `UPDATE data_export_archive_reservations SET reserved_bytes=?,state='ready',lease_until=NULL WHERE job_id=? AND user_id=? AND state='building' AND lease_owner=?`, archiveSize, job.id, job.userID, workerID)
		if err != nil {
			return err
		}
		changed, err = res.RowsAffected()
		if err != nil {
			return err
		}
		if changed != 1 {
			return pkg.ErrNotFound
		}
		res, err = tx.ExecContext(ctx, `UPDATE data_exports SET attachment_status='ready',attachment_error=NULL WHERE id=? AND user_id=? AND attachment_status='building' AND expires_at>CURRENT_TIMESTAMP AND EXISTS(SELECT 1 FROM users u WHERE u.id=data_exports.user_id AND u.is_bot=0 AND u.deleted_at IS NULL AND u.is_platform_banned=0 AND NOT EXISTS(SELECT 1 FROM account_lifecycle l WHERE l.user_id=u.id AND l.disabled_at IS NOT NULL)) AND EXISTS(SELECT 1 FROM data_export_archive_reservations r WHERE r.job_id=data_exports.id AND r.state='ready' AND r.lease_owner=?)`, job.id, job.userID, workerID)
		if err != nil {
			return err
		}
		changed, err = res.RowsAffected()
		if err != nil {
			return err
		}
		if changed != 1 {
			return pkg.ErrNotFound
		}
		if err := os.Rename(tempPath, finalPath); err != nil {
			return err
		}
		renamed = true
		callbackSucceeded = true
		return nil
	})
	if err != nil {
		if renamed && !callbackSucceeded {
			_ = os.Remove(finalPath)
		}
		if !callbackSucceeded {
			return err
		}
		return errors.Join(errArchiveCommitAmbiguous, err)
	}
	return nil
}

func (r *sqliteDataExportRepo) failArchive(id, workerID, code string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _ = r.db.ExecContext(ctx, `UPDATE data_exports SET attachment_status='failed',attachment_error=? WHERE id=? AND attachment_status='building' AND EXISTS(SELECT 1 FROM data_export_archive_reservations r WHERE r.job_id=data_exports.id AND r.state='building' AND r.lease_owner=?)`, code, id, workerID)
}

func (r *sqliteDataExportRepo) releaseArchiveReservation(ctx context.Context, id, workerID string) error {
	raw := database.RawDB(r.db)
	if raw == nil {
		return errors.New("archive reservation release requires a transactional database")
	}
	return database.WithTx(ctx, raw, func(tx *sql.Tx) error {
		// All writers acquire the singleton budget row before reservations. This
		// consistent order prevents PG deadlocks and serializes the byte ledger.
		if _, err := tx.ExecContext(ctx, `UPDATE data_export_archive_budget SET reserved_bytes=reserved_bytes WHERE id=1`); err != nil {
			return err
		}
		var amount int64
		var state, leaseOwner string
		err := tx.QueryRowContext(ctx, `SELECT reserved_bytes,state,COALESCE(lease_owner,'') FROM data_export_archive_reservations WHERE job_id=?`, id).Scan(&amount, &state, &leaseOwner)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if workerID != "" && (state != "building" || leaseOwner != workerID) {
			return nil
		}
		if workerID == "" && state == "building" {
			return nil
		}
		result, err := tx.ExecContext(ctx, `DELETE FROM data_export_archive_reservations WHERE job_id=? AND state=? AND COALESCE(lease_owner,'')=?`, id, state, leaseOwner)
		if err != nil {
			return err
		}
		changed, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if changed != 1 {
			return nil
		}
		result, err = tx.ExecContext(ctx, `UPDATE data_export_archive_budget SET reserved_bytes=reserved_bytes-? WHERE id=1 AND reserved_bytes>=?`, amount, amount)
		if err != nil {
			return err
		}
		changed, err = result.RowsAffected()
		if err != nil {
			return err
		}
		if changed != 1 {
			return errors.New("archive budget ledger is inconsistent")
		}
		return nil
	})
}

func (r *sqliteDataExportRepo) cleanupSupersededArchive(ctx context.Context, id string) {
	// Retain both bytes and quota through the export's advertised TTL. A
	// downloader may already have opened this immutable generation; unlinking
	// it here is especially unreliable on Windows and would undercount bytes.
	cleanupCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	raw := database.RawDB(r.db)
	if raw == nil {
		return
	}
	_ = database.WithTx(cleanupCtx, raw, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(cleanupCtx, `UPDATE data_export_archive_budget SET reserved_bytes=reserved_bytes WHERE id=1`); err != nil {
			return err
		}
		_, err := tx.ExecContext(cleanupCtx, `UPDATE data_export_archive_reservations SET state='abandoned',lease_until=NULL WHERE job_id=? AND state='ready'`, id)
		return err
	})
}

func (r *sqliteDataExportRepo) recoverExpiredArchiveLeases(ctx context.Context) error {
	raw := database.RawDB(r.db)
	if raw == nil {
		return errors.New("archive recovery requires a transactional database")
	}
	var expired []string
	err := database.WithTx(ctx, raw, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `UPDATE data_export_archive_budget SET reserved_bytes=reserved_bytes WHERE id=1`); err != nil {
			return err
		}
		rows, err := tx.QueryContext(ctx, `SELECT job_id,reserved_bytes FROM data_export_archive_reservations WHERE state='building' AND lease_until<=?`, time.Now().UTC())
		if err != nil {
			return err
		}
		for rows.Next() {
			var id string
			var reserved int64
			if err := rows.Scan(&id, &reserved); err != nil {
				rows.Close()
				return err
			}
			expired = append(expired, id)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		if err := rows.Close(); err != nil {
			return err
		}
		for _, id := range expired {
			removed, err := tx.ExecContext(ctx, `UPDATE data_export_archive_reservations SET state='abandoned',lease_until=NULL,expires_at=? WHERE job_id=? AND state='building' AND lease_until<=?`, time.Now().UTC().Add(exportArchiveWorkLimit+exportArchiveLease), id, time.Now().UTC())
			if err != nil {
				return err
			}
			changed, err := removed.RowsAffected()
			if err != nil {
				return err
			}
			if changed == 0 {
				continue
			}
			if _, err := tx.ExecContext(ctx, `UPDATE data_exports SET attachment_status='failed',attachment_error='worker_interrupted' WHERE id=? AND attachment_status='building' AND EXISTS(SELECT 1 FROM data_export_archive_reservations r WHERE r.job_id=data_exports.id AND r.state='abandoned')`, id); err != nil {
				return err
			}
		}
		// A crash between claiming the row and reserving budget leaves no lease.
		if _, err = tx.ExecContext(ctx, `UPDATE data_exports SET attachment_status='failed',attachment_error='worker_interrupted' WHERE attachment_status='building' AND NOT EXISTS(SELECT 1 FROM data_export_archive_reservations r WHERE r.job_id=data_exports.id)`); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `UPDATE data_export_archive_budget SET reserved_bytes=COALESCE((SELECT SUM(reserved_bytes) FROM data_export_archive_reservations),0) WHERE id=1`)
		return err
	})
	if err != nil {
		return err
	}
	return r.removeStaleArchives(ctx)
}

func (r *sqliteDataExportRepo) PurgeExpired(ctx context.Context) error {
	if r.archiveDir != "" && r.uploadDir != "" {
		if err := EnsureDataExportStorage(r.uploadDir, r.archiveDir); err != nil {
			return err
		}
		if err := r.recoverExpiredArchiveLeases(ctx); err != nil {
			return err
		}
	}
	if _, err := r.db.ExecContext(ctx, `DELETE FROM data_exports WHERE expires_at<=CURRENT_TIMESTAMP`); err != nil {
		return err
	}
	return r.removeStaleArchives(ctx)
}

func (r *sqliteDataExportRepo) removeStaleArchives(ctx context.Context) error {
	if r.archiveDir == "" {
		return nil
	}
	entries, err := os.ReadDir(r.archiveDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	rows, err := r.db.QueryContext(ctx, `SELECT e.id,r.lease_owner FROM data_exports e JOIN data_export_archive_reservations r ON r.job_id=e.id AND r.user_id=e.user_id AND r.state='ready' WHERE e.status='ready' AND e.attachment_status='ready' AND e.expires_at>CURRENT_TIMESTAMP AND EXISTS(SELECT 1 FROM users u WHERE u.id=e.user_id AND u.is_bot=0 AND u.deleted_at IS NULL AND u.is_platform_banned=0 AND NOT EXISTS(SELECT 1 FROM account_lifecycle l WHERE l.user_id=u.id AND l.disabled_at IS NOT NULL))`)
	if err != nil {
		return err
	}
	active := make(map[string]struct{})
	for rows.Next() {
		var id, generation string
		if err := rows.Scan(&id, &generation); err != nil {
			_ = rows.Close()
			return err
		}
		active[id+"-"+generation] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	building, err := r.db.QueryContext(ctx, `SELECT job_id,lease_owner FROM data_export_archive_reservations WHERE state='building'`)
	if err != nil {
		return err
	}
	buildingKeys := make(map[string]struct{})
	for building.Next() {
		var id, generation string
		if err := building.Scan(&id, &generation); err != nil {
			building.Close()
			return err
		}
		buildingKeys[id+"-"+generation] = struct{}{}
	}
	if err := building.Err(); err != nil {
		building.Close()
		return err
	}
	if err := building.Close(); err != nil {
		return err
	}
	type abandonedLease struct {
		generation string
		expires    time.Time
	}
	abandoned := make(map[string]abandonedLease)
	abandonedRows, err := r.db.QueryContext(ctx, `SELECT job_id,lease_owner,expires_at FROM data_export_archive_reservations WHERE state='abandoned'`)
	if err != nil {
		return err
	}
	for abandonedRows.Next() {
		var id string
		var lease abandonedLease
		if err := abandonedRows.Scan(&id, &lease.generation, &lease.expires); err != nil {
			abandonedRows.Close()
			return err
		}
		abandoned[id] = lease
	}
	if err := abandonedRows.Err(); err != nil {
		abandonedRows.Close()
		return err
	}
	if err := abandonedRows.Close(); err != nil {
		return err
	}
	ready, err := r.db.QueryContext(ctx, `SELECT job_id,lease_owner,expires_at FROM data_export_archive_reservations WHERE state='ready'`)
	if err != nil {
		return err
	}
	var orphanedReady []orphanedArchive
	for ready.Next() {
		var item orphanedArchive
		if err := ready.Scan(&item.id, &item.generation, &item.expires); err != nil {
			ready.Close()
			return err
		}
		if _, ok := active[item.id+"-"+item.generation]; !ok {
			orphanedReady = append(orphanedReady, item)
		}
	}
	if err := ready.Err(); err != nil {
		ready.Close()
		return err
	}
	if err := ready.Close(); err != nil {
		return err
	}
	for _, item := range orphanedReady {
		markedAbandoned, isActive, err := r.abandonOrphanedReadyArchive(ctx, item)
		if err != nil {
			return err
		}
		if markedAbandoned {
			abandoned[item.id] = abandonedLease{generation: item.generation, expires: item.expires}
		} else if isActive {
			// Publication may have committed after the active snapshot above.
			// Preserve its immutable ZIP in this pass as well.
			active[item.id+"-"+item.generation] = struct{}{}
		}
	}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		name := entry.Name()
		if strings.HasPrefix(name, ".tmp-") {
			if len(name) >= len(".tmp-")+48+1+48+1 {
				id := name[len(".tmp-") : len(".tmp-")+48]
				generationStart := len(".tmp-") + 48 + 1
				generation := name[generationStart : generationStart+48]
				key := id + "-" + generation
				if _, keep := buildingKeys[key]; keep {
					continue
				}
				if lease, ok := abandoned[id]; ok && lease.generation == generation && time.Now().Before(lease.expires) {
					continue
				}
				info, infoErr := entry.Info()
				if infoErr != nil || !info.Mode().IsRegular() {
					continue
				}
				_ = os.Remove(filepath.Join(r.archiveDir, name))
			}
			continue
		}
		if !strings.HasSuffix(name, ".zip") {
			continue
		}
		stem := strings.TrimSuffix(name, ".zip")
		parts := strings.Split(stem, "-")
		if len(parts) != 2 || !exportIDPattern.MatchString(parts[0]) || !exportIDPattern.MatchString(parts[1]) {
			continue
		}
		id, generation := parts[0], parts[1]
		key := id + "-" + generation
		if _, ok := active[key]; ok {
			continue
		}
		if _, ok := buildingKeys[key]; ok {
			continue
		}
		if lease, ok := abandoned[id]; ok && lease.generation == generation && time.Now().Before(lease.expires) {
			continue
		}
		info, infoErr := entry.Info()
		if infoErr != nil || !info.Mode().IsRegular() {
			continue
		}
		_ = os.Remove(filepath.Join(r.archiveDir, name))
	}
	remaining, err := os.ReadDir(r.archiveDir)
	if err != nil {
		return err
	}
	for id, lease := range abandoned {
		if time.Now().Before(lease.expires) {
			continue
		}
		prefix := ".tmp-" + id + "-" + lease.generation + "-"
		zipName := id + "-" + lease.generation + ".zip"
		present := false
		for _, entry := range remaining {
			if strings.HasPrefix(entry.Name(), prefix) || entry.Name() == zipName {
				present = true
				break
			}
		}
		if !present {
			_ = r.releaseArchiveReservation(ctx, id, "")
		}
	}
	return nil
}

// abandonOrphanedReadyArchive makes the orphan decision against the current
// committed export state, rather than trusting removeStaleArchives' earlier
// active snapshot. Publication and cleanup can otherwise cross and cleanup may
// unlink a just-published generation.
func (r *sqliteDataExportRepo) abandonOrphanedReadyArchive(ctx context.Context, item orphanedArchive) (abandoned, active bool, err error) {
	raw := database.RawDB(r.db)
	if raw == nil {
		return false, false, errors.New("archive cleanup requires a transactional database")
	}
	err = database.WithTx(ctx, raw, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `UPDATE data_export_archive_budget SET reserved_bytes=reserved_bytes WHERE id=1`); err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, `UPDATE data_export_archive_reservations SET state='abandoned',lease_until=NULL WHERE job_id=? AND lease_owner=? AND state='ready'
			AND NOT EXISTS(SELECT 1 FROM data_exports e JOIN users u ON u.id=e.user_id WHERE e.id=data_export_archive_reservations.job_id AND e.user_id=data_export_archive_reservations.user_id AND e.status='ready' AND e.attachment_status='ready' AND e.expires_at>CURRENT_TIMESTAMP AND u.is_bot=0 AND u.deleted_at IS NULL AND u.is_platform_banned=0 AND NOT EXISTS(SELECT 1 FROM account_lifecycle l WHERE l.user_id=u.id AND l.disabled_at IS NOT NULL))`, item.id, item.generation)
		if err != nil {
			return err
		}
		changed, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if changed == 1 {
			abandoned = true
			return nil
		}
		var exists int
		err = tx.QueryRowContext(ctx, `SELECT 1 FROM data_exports e JOIN data_export_archive_reservations r ON r.job_id=e.id AND r.user_id=e.user_id AND r.state='ready' AND r.lease_owner=? JOIN users u ON u.id=e.user_id WHERE e.id=? AND e.status='ready' AND e.attachment_status='ready' AND e.expires_at>CURRENT_TIMESTAMP AND u.is_bot=0 AND u.deleted_at IS NULL AND u.is_platform_banned=0 AND NOT EXISTS(SELECT 1 FROM account_lifecycle l WHERE l.user_id=u.id AND l.disabled_at IS NOT NULL)`, item.generation, item.id).Scan(&exists)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		active = true
		return nil
	})
	return abandoned, active, err
}
