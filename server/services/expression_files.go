// Package services — expression_files.go: the on-disk files behind custom
// emojis and stickers. publishExpressionFile is the single write path
// (temp file + rename); readOwnExpressionFile reads a stored file back for
// the clone path.
package services

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"regexp"
	"strings"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

var (
	// expressionPNGMagic / expressionGIFMagic are the leading bytes of our
	// own encoder output (png.Encode / gif.EncodeAll).
	expressionPNGMagic = []byte("\x89PNG\r\n\x1a\n")
	expressionGIFMagic = []byte("GIF8")
	// expressionFileRel is the only relative upload path readOwnExpressionFile
	// resolves: the exact shape publishExpressionFile produces for a
	// server-generated 16-hex id.
	expressionFileRel = regexp.MustCompile(`^(?:emojis|stickers)/[a-f0-9]{16}\.(?:png|gif)$`)
)

// publishExpressionFile writes data to dir/name through a temp file +
// rename, so the file is either absent or complete at its public URL (same
// reasoning as handlers/badge.go's icon upload). dir is uploadDir/subdir;
// returns the "/api/uploads/{subdir}/{name}" URL.
func publishExpressionFile(dir, subdir, name string, data []byte) (string, error) {
	dest, err := pkg.SafeJoin(dir, name)
	if err != nil {
		return "", fmt.Errorf("%w: invalid expression file name", pkg.ErrInternal)
	}
	tmp, err := os.CreateTemp(dir, ".upload-*")
	if err != nil {
		return "", fmt.Errorf("failed to create expression file: %w", err)
	}
	tmpPath := tmp.Name()
	// Close before rename/remove — Windows refuses both on an open handle.
	_, writeErr := tmp.Write(data)
	closeErr := tmp.Close()
	if writeErr != nil || closeErr != nil {
		_ = os.Remove(tmpPath)
		return "", fmt.Errorf("failed to write expression file: %w", errors.Join(writeErr, closeErr))
	}
	// dest is the SafeJoin result above (name is built from a server-generated
	// hex id); tmpPath is os.CreateTemp's own name in the same directory.
	if err := os.Rename(tmpPath, dest); err != nil { // #nosec G703 -- both paths are SafeJoin/CreateTemp results, never request input

		_ = os.Remove(tmpPath)
		return "", fmt.Errorf("failed to publish expression file: %w", err)
	}
	return uploadURLPrefix + subdir + "/" + name, nil
}

// readOwnExpressionFile reads back a stored emoji/sticker file by its row
// URL. Only "/api/uploads/{emojis|stickers}/{16-hex}.{png|gif}" resolves,
// through pkg.SafeJoin; the file must be at most
// models.ExpressionStoredFileMaxBytes and start with magic. A missing file
// is models.ErrExpressionNotFound; every other failure is an internal error
// (the URL and file are server-generated, so a mismatch is not client input).
func readOwnExpressionFile(uploadDir, fileURL string, magic []byte) ([]byte, error) {
	rel, ok := strings.CutPrefix(fileURL, uploadURLPrefix)
	if !ok || !expressionFileRel.MatchString(rel) {
		return nil, fmt.Errorf("%w: unexpected expression file url", pkg.ErrInternal)
	}
	full, err := pkg.SafeJoin(uploadDir, rel)
	if err != nil {
		return nil, fmt.Errorf("%w: expression file outside upload dir", pkg.ErrInternal)
	}
	f, err := os.Open(full) // #nosec G304 -- full is a SafeJoin result of a pattern-checked server-generated path
	if errors.Is(err, fs.ErrNotExist) {
		return nil, models.ErrExpressionNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to open expression file: %w", err)
	}
	defer func() { _ = f.Close() }()

	info, err := f.Stat()
	if err != nil {
		return nil, fmt.Errorf("failed to stat expression file: %w", err)
	}
	if !info.Mode().IsRegular() || info.Size() > models.ExpressionStoredFileMaxBytes {
		return nil, fmt.Errorf("%w: stored expression file is not a regular file within the size cap", pkg.ErrInternal)
	}
	data, err := io.ReadAll(io.LimitReader(f, models.ExpressionStoredFileMaxBytes+1))
	if err != nil {
		return nil, fmt.Errorf("failed to read expression file: %w", err)
	}
	if len(data) > models.ExpressionStoredFileMaxBytes {
		return nil, fmt.Errorf("%w: stored expression file grew past the size cap", pkg.ErrInternal)
	}
	if !bytes.HasPrefix(data, magic) {
		return nil, fmt.Errorf("%w: stored expression file has an unexpected format", pkg.ErrInternal)
	}
	return data, nil
}
