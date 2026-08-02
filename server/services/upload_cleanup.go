// Package services — best-effort on-disk cleanup for deleted attachment rows.
//
// attachments.message_id and dm_attachments.dm_message_id both declare
// ON DELETE CASCADE, but the production database (Turso/libSQL) never turns
// the foreign_keys PRAGMA on (see database/integrity.go), so that cascade
// never actually fires there. And even where it does fire (local SQLite
// dev), a row cascade only ever removes the DB row — nothing removes the
// file its file_url pointed to on disk. Every message/DM-message/channel/
// server/feedback-ticket delete path in this package therefore pairs its DB
// delete with a best-effort call into removeUploadFilesByURL below.
package services

import (
	"errors"
	"io/fs"
	"os"
	"strings"

	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/logx"
)

var uploadCleanupLogger = logx.Component("service.upload_cleanup")

// uploadURLPrefix is the only file_url shape removeUploadFilesByURL will
// ever resolve to a disk path. Anything else (externally hosted URLs, a
// future non-local storage backend) is skipped, not deleted.
const uploadURLPrefix = "/api/uploads/"

// removeUploadFilesByURL best-effort deletes the on-disk files behind a set
// of attachment file_url values. It never returns an error — every failure
// (unrecognized prefix, traversal rejection, already-gone file, OS error)
// is logged and the loop moves on. Callers always run this AFTER the owning
// DB row is already gone: a delete that failed here but blocked the caller
// would leave a live DB row pointing at a wiped file, which is worse than a
// leaked one.
//
// uploadDir is shared by every media kind this server stores locally
// (avatars, wallpapers, server icons/banners, soundboard clips, badge
// icons, plus the four attachment tables) — this function only ever
// removes the exact relative path decoded from each given URL, never
// sweeps the directory. A user who has pointed their own avatar_url at an
// attachment URL (by reusing an uploaded file's link) will lose that
// avatar when the attachment's owning message is deleted; that's accepted
// collateral of not tracking cross-table references, not a bug here.
//
// A blank uploadDir is the "cleanup disabled" no-op: SetUploadDir is only
// called from init_services.go, so any caller constructed directly in a
// test without it (the common case) gets a safe no-op instead of a panic.
func removeUploadFilesByURL(uploadDir string, fileURLs []string) {
	if uploadDir == "" {
		return
	}

	for _, url := range fileURLs {
		if !strings.HasPrefix(url, uploadURLPrefix) {
			uploadCleanupLogger.Warn("skipping non-upload file_url", "url", url)
			continue
		}
		rel := strings.TrimPrefix(url, uploadURLPrefix)
		if rel == "" {
			uploadCleanupLogger.Warn("skipping empty file_url after prefix strip", "url", url)
			continue
		}

		full, err := pkg.SafeJoin(uploadDir, rel)
		if err != nil {
			// Never delete on a SafeJoin failure — that's the traversal guard.
			uploadCleanupLogger.Warn("refusing to remove file outside upload dir", "url", url, "err", pkg.ErrText(err))
			continue
		}

		if err := os.Remove(full); err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				continue // already gone, nothing to log
			}
			uploadCleanupLogger.Warn("failed to remove upload file", "url", url, "err", pkg.ErrText(err))
		}
	}
}
