// Package pkg — path-safety helpers for upload services.
//
// gosec G304 flagged every os.Create(destPath) where destPath includes a
// user-influenced filename, even though our upload services already run
// the original name through SanitizeFilename + prepend a random hex
// prefix. The flag is reasonable defense-in-depth: a future refactor
// could change the input shape and the implicit containment guarantee
// would silently break.
//
// SafeJoin enforces the guarantee explicitly: the joined path MUST live
// inside baseDir. Anything else returns an error before any open() call.
package pkg

import (
	"fmt"
	"path/filepath"
	"strings"
)

// SafeJoin returns filepath.Join(baseDir, child) but only when the result
// resolves to a path strictly inside baseDir. It rejects:
//   - "..": traversal segments
//   - absolute child paths
//   - any join whose canonical form escapes baseDir (covers symlink-style
//     concatenation like "subdir/../../etc/passwd")
//
// The check uses cleaned, absolute paths so platform-specific separators
// and "./" / ".." segments are normalized before comparison.
func SafeJoin(baseDir, child string) (string, error) {
	if strings.Contains(child, "\x00") {
		return "", fmt.Errorf("safejoin: null byte in path")
	}

	absBase, err := filepath.Abs(baseDir)
	if err != nil {
		return "", fmt.Errorf("safejoin: bad base: %w", err)
	}
	absBase = filepath.Clean(absBase)

	joined := filepath.Join(absBase, child)
	cleaned := filepath.Clean(joined)

	// Append a trailing separator to baseDir before the prefix check so
	// "/srv/uploads2" doesn't pass when baseDir is "/srv/uploads".
	if !strings.HasPrefix(cleaned, absBase+string(filepath.Separator)) && cleaned != absBase {
		return "", fmt.Errorf("safejoin: %q escapes %q", child, baseDir)
	}

	return cleaned, nil
}
