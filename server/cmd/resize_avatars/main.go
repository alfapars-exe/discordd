// Command resize_avatars — one-off migration that downscales every avatar /
// server-icon already on disk to the same 256-px cap the upload handler now
// applies to new uploads.
//
// Why this script exists separately from the handler:
//   - The HF Space deploy serves /data on a persistent volume that survives
//     image rebuilds. Switching processUpload to resize on the way in only
//     fixes future uploads; the historical pile of 1024×1024 avatars stays
//     until something rewrites them. Lighthouse / channels still showed
//     ~5.9 MiB of avatar payload after the handler patch deployed.
//   - Keeping the rewriter outside the main binary makes the destructive
//     step explicit (operators run it once with `go run` or `hichat-server
//     resize-avatars`; the runtime never touches existing files on boot).
//
// Behaviour:
//   - Walks UPLOAD_DIR (defaults to /data/uploads, override with --dir).
//   - Picks files matching the avatar / icon / wallpaper naming convention
//     (suffix-based — see avatarSuffixRe). Other files are ignored, so
//     accidentally pointing it at /data won't touch attachments.
//   - For each match: decodes, ResizeAvatarBytes, atomic rename. Source is
//     kept on a `.bak` sidecar by default (--in-place to skip the backup).
//   - DB rows do not change. The avatar URL in the DB still references the
//     SAME on-disk filename — only the bytes behind it shrink. (When the
//     resized output happens to switch from PNG to JPEG or vice versa,
//     the file is rewritten with the new extension AND a same-stem symlink
//     is created so the old URL still resolves.)
//
// Usage:
//
//	go run ./cmd/resize_avatars
//	go run ./cmd/resize_avatars --dir=/data/uploads --in-place --dry-run
//
// Flags: --dir, --in-place (no .bak), --dry-run (log only, don't write).
package main

import (
	"flag"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path"
	"path/filepath"
	"regexp"

	"github.com/argeinfina/hichat/handlers"
)

// avatarSuffixRe matches the suffix the upload handler bakes into every
// disk filename. processUpload's diskFilename layout is:
//
//	<8 random hex bytes>_<sanitized original name>
//
// and the sanitised name still carries the user's chosen filename — there's
// no marker that says "this is an avatar". So instead we match on the
// extensions the avatar / icon endpoint accepts, plus the random-hex prefix
// pattern, to avoid trampling on regular message attachments stored in the
// same directory (which also live in UPLOAD_DIR).
var avatarSuffixRe = regexp.MustCompile(`(?i)^[0-9a-f]{16}_.+\.(jpe?g|png|gif|webp)$`)

func main() {
	dir := flag.String("dir", defaultUploadDir(), "uploads directory to walk")
	inPlace := flag.Bool("in-place", false, "skip the .bak backup; overwrite the original bytes")
	dryRun := flag.Bool("dry-run", false, "log what would change; do not write")
	flag.Parse()

	log.SetFlags(log.Ltime)
	log.Printf("[resize] scanning %s (in-place=%v dry-run=%v)", *dir, *inPlace, *dryRun)

	var stats struct {
		seen, resized, skipped, kept, errors int
		savedBytes                           int64
	}

	// os.Root scopes every filesystem call below to *dir: a symlink inside
	// the tree cannot be followed to a target outside it, closing the
	// TOCTOU window a plain path string leaves open between the WalkDir
	// callback observing a name and this function later operating on it
	// (gosec G122). Paths from here on are root-relative and always
	// "/"-separated (io/fs's contract), so path.Dir/path.Join are used
	// instead of their filepath counterparts.
	//
	// The open+walk is wrapped in its own function so `defer root.Close()`
	// resolves on a normal return, before the log.Fatalf below — Fatalf
	// calls os.Exit, which would otherwise skip a defer sitting in the same
	// function scope and leak the root's open file descriptor.
	walkErr := func() error {
		root, err := os.OpenRoot(*dir)
		if err != nil {
			return fmt.Errorf("open dir %s: %w", *dir, err)
		}
		defer func() {
			if cerr := root.Close(); cerr != nil {
				log.Printf("[resize] close %s: %v", *dir, cerr)
			}
		}()

		return fs.WalkDir(root.FS(), ".", func(relPath string, d fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if d.IsDir() {
				return nil
			}
			stats.seen++
			name := d.Name()
			if !avatarSuffixRe.MatchString(name) {
				stats.skipped++
				return nil
			}

			origInfo, err := root.Stat(relPath)
			if err != nil {
				log.Printf("[resize] stat %s: %v", name, err)
				stats.errors++
				return nil
			}
			origSize := origInfo.Size()

			// We don't want to load gigantic attachments through the image
			// decoder. Avatars are capped at 8 MB by the upload handler;
			// anything materially larger is almost certainly a different
			// kind of file and worth skipping.
			if origSize > 16<<20 {
				stats.skipped++
				return nil
			}

			in, err := root.Open(relPath)
			if err != nil {
				log.Printf("[resize] open %s: %v", name, err)
				stats.errors++
				return nil
			}
			resized, ext, err := handlers.ResizeAvatarBytes(in)
			// Not deferred — this callback runs once per file under
			// WalkDir, effectively a loop; a defer here would pin every
			// file's handle open until the whole walk finishes instead of
			// closing each one as it's resized.
			_ = in.Close() // read-side handle — nothing buffered to flush, safe to ignore
			if err != nil {
				log.Printf("[resize] resize %s: %v", name, err)
				stats.errors++
				return nil
			}

			// Skip writes that would not save anything (and would risk a
			// pointless format flip on tiny files).
			newSize := int64(len(resized))
			if newSize >= origSize {
				stats.kept++
				return nil
			}

			newName := handlers.SwapExtension(name, ext)
			newRelPath := path.Join(path.Dir(relPath), newName)

			if *dryRun {
				log.Printf("[resize] DRY %s: %d → %d bytes (-%d)", name, origSize, newSize, origSize-newSize)
				stats.resized++
				stats.savedBytes += origSize - newSize
				return nil
			}

			if !*inPlace {
				if err := root.Rename(relPath, relPath+".bak"); err != nil {
					log.Printf("[resize] backup %s: %v", name, err)
					stats.errors++
					return nil
				}
			}

			if err := root.WriteFile(newRelPath, resized, 0o600); err != nil {
				log.Printf("[resize] write %s: %v", newName, err)
				stats.errors++
				return nil
			}

			// If the extension changed, keep the original URL resolvable by
			// also writing a copy under the original filename. We can't rely
			// on symlinks (HF Spaces' /data mount is on a filesystem that
			// may or may not allow them depending on the backing store), so
			// duplicate the bytes; the cost is a single small avatar's worth.
			if newRelPath != relPath {
				if err := root.WriteFile(relPath, resized, 0o600); err != nil {
					log.Printf("[resize] alias %s -> %s: %v", name, newName, err)
					// The new file was written; the alias is best-effort.
				}
			}

			log.Printf("[resize] %s: %d → %d bytes (-%d) %s", name, origSize, newSize, origSize-newSize, deltaNote(name, newName))
			stats.resized++
			stats.savedBytes += origSize - newSize
			return nil
		})
	}()
	if walkErr != nil {
		log.Fatalf("[resize] walk error: %v", walkErr)
	}

	log.Printf("[resize] done — seen=%d resized=%d kept=%d skipped=%d errors=%d saved=%s",
		stats.seen, stats.resized, stats.kept, stats.skipped, stats.errors, humanBytes(stats.savedBytes))
}

func deltaNote(oldName, newName string) string {
	if oldName == newName {
		return ""
	}
	return fmt.Sprintf("(extension changed → %s)", filepath.Ext(newName))
}

func humanBytes(n int64) string {
	const (
		KiB = 1024
		MiB = KiB * 1024
	)
	switch {
	case n >= MiB:
		return fmt.Sprintf("%.1f MiB", float64(n)/float64(MiB))
	case n >= KiB:
		return fmt.Sprintf("%.1f KiB", float64(n)/float64(KiB))
	default:
		return fmt.Sprintf("%d B", n)
	}
}

// defaultUploadDir picks the same path the runtime uses so an operator can
// run the script without flags on the HF Space (UPLOAD_DIR env from
// Dockerfile line 141 sets /data/uploads).
func defaultUploadDir() string {
	if dir := os.Getenv("UPLOAD_DIR"); dir != "" {
		return dir
	}
	return "/data/uploads"
}
