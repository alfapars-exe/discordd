package services

import (
	"os"
	"path/filepath"
	"testing"
)

// TestRemoveUploadFilesByURL_DeletesMatchingFile is the core guarantee: a
// well-formed /api/uploads/ URL for a file that exists gets removed.
func TestRemoveUploadFilesByURL_DeletesMatchingFile(t *testing.T) {
	dir := t.TempDir()
	name := "deadbeef_photo.png"
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("bytes"), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	removeUploadFilesByURL(dir, []string{"/api/uploads/" + name})

	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("file still exists after cleanup: stat err = %v", err)
	}
}

// TestRemoveUploadFilesByURL_BlankUploadDirIsNoOp: the "cleanup disabled"
// path (uploadDir never wired via SetUploadDir, or a test's default zero
// value) must not touch anything on disk.
func TestRemoveUploadFilesByURL_BlankUploadDirIsNoOp(t *testing.T) {
	dir := t.TempDir()
	name := "deadbeef_photo.png"
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("bytes"), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	// uploadDir="" — the value every service field defaults to before
	// SetUploadDir is called.
	removeUploadFilesByURL("", []string{"/api/uploads/" + name})

	if _, err := os.Stat(path); err != nil {
		t.Errorf("file removed despite a blank (disabled) upload dir: stat err = %v", err)
	}
}

// TestRemoveUploadFilesByURL_SkipsNonUploadPrefix: a file_url that doesn't
// start with /api/uploads/ (e.g. a future non-local storage backend, or a
// stray externally-hosted URL) is left alone — this function only ever
// resolves the one URL shape local uploads actually use.
func TestRemoveUploadFilesByURL_SkipsNonUploadPrefix(t *testing.T) {
	dir := t.TempDir()
	name := "x.png"
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("bytes"), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	removeUploadFilesByURL(dir, []string{"/static/" + name, "https://cdn.example.com/x.png"})

	if _, err := os.Stat(path); err != nil {
		t.Errorf("file removed via a non /api/uploads/ prefix: stat err = %v", err)
	}
}

// TestRemoveUploadFilesByURL_RefusesTraversal is the load-bearing security
// guarantee: a file_url that decodes to a path outside uploadDir (via
// SafeJoin) must NEVER be removed, no matter how the URL was crafted.
func TestRemoveUploadFilesByURL_RefusesTraversal(t *testing.T) {
	parent := t.TempDir()
	uploadDir := filepath.Join(parent, "uploads")
	if err := os.Mkdir(uploadDir, 0o750); err != nil {
		t.Fatalf("mkdir upload dir: %v", err)
	}
	secretPath := filepath.Join(parent, "evil.txt")
	if err := os.WriteFile(secretPath, []byte("do-not-delete-me"), 0o600); err != nil {
		t.Fatalf("write fixture outside upload dir: %v", err)
	}

	removeUploadFilesByURL(uploadDir, []string{"/api/uploads/../evil.txt"})

	if _, err := os.Stat(secretPath); err != nil {
		t.Errorf("traversal URL reached outside uploadDir: stat err = %v", err)
	}
}

// TestRemoveUploadFilesByURL_AlreadyGoneFileIsTolerated: a file_url whose
// disk file no longer exists (deleted by a previous cleanup pass, or never
// written) must not be treated as an error — the function has no error
// return, this test's real assertion is "does not panic and does not touch
// any unrelated fixture".
func TestRemoveUploadFilesByURL_AlreadyGoneFileIsTolerated(t *testing.T) {
	dir := t.TempDir()
	neighbor := filepath.Join(dir, "neighbor.png")
	if err := os.WriteFile(neighbor, []byte("bytes"), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	removeUploadFilesByURL(dir, []string{"/api/uploads/never-existed.png"})

	if _, err := os.Stat(neighbor); err != nil {
		t.Errorf("unrelated file touched while handling an already-gone URL: stat err = %v", err)
	}
}

// TestRemoveUploadFilesByURL_LeavesUnlistedNeighborsAlone pins the "no
// directory sweep" invariant: uploadDir is shared by every locally-stored
// media kind (avatars, wallpapers, soundboard clips, badge icons, plus the
// four attachment tables) — only the exact URLs passed in are ever removed,
// never anything else found nearby, including files in a badges/ subdir.
func TestRemoveUploadFilesByURL_LeavesUnlistedNeighborsAlone(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target.png")
	if err := os.WriteFile(target, []byte("bytes"), 0o600); err != nil {
		t.Fatalf("write target fixture: %v", err)
	}

	badgesDir := filepath.Join(dir, "badges")
	if err := os.Mkdir(badgesDir, 0o750); err != nil {
		t.Fatalf("mkdir badges dir: %v", err)
	}
	badgeIcon := filepath.Join(badgesDir, "badge_keepme.png")
	if err := os.WriteFile(badgeIcon, []byte("bytes"), 0o600); err != nil {
		t.Fatalf("write badge fixture: %v", err)
	}

	removeUploadFilesByURL(dir, []string{"/api/uploads/target.png"})

	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Errorf("target.png still exists: stat err = %v", err)
	}
	if _, err := os.Stat(badgeIcon); err != nil {
		t.Errorf("unlisted badges/ neighbor was touched: stat err = %v", err)
	}
}
