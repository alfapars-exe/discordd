// migrate-uploads is an offline, non-destructive copy verifier for HF mounts.
// Stop application writes before using -apply; changing UPLOAD_DIR is separate.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
)

type report struct {
	SourceFiles int      `json:"source_files"`
	Missing     []string `json:"missing"`
	Conflicts   []string `json:"conflicts"`
	Copied      int      `json:"copied"`
	Verified    bool     `json:"verified"`
}

func digest(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err = io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func inventory(root string) (map[string]string, error) {
	info, err := os.Lstat(root)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("root must be a real directory")
	}
	files := map[string]string{}
	err = filepath.WalkDir(root, func(path string, e fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if e.IsDir() {
			return nil
		}
		if !e.Type().IsRegular() {
			return fmt.Errorf("unsupported entry: %s", path)
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		files[rel], err = digest(path)
		return err
	})
	return files, err
}

func migrate(src, dst string, apply bool) (report, error) {
	r := report{}
	source, err := inventory(src)
	if err != nil {
		return r, err
	}
	if len(source) == 0 {
		return r, errors.New("empty source rejected; verify mount availability")
	}
	target, err := inventory(dst)
	if err != nil {
		return r, err
	}
	r.SourceFiles = len(source)
	for name, hash := range source {
		if existing, ok := target[name]; !ok {
			r.Missing = append(r.Missing, name)
		} else if existing != hash {
			r.Conflicts = append(r.Conflicts, name)
		}
	}
	sort.Strings(r.Missing)
	sort.Strings(r.Conflicts)
	if len(r.Conflicts) > 0 {
		return r, errors.New("content conflicts; nothing copied")
	}
	if !apply {
		return r, nil
	}
	for _, name := range r.Missing {
		path := filepath.Join(dst, name)
		if err := os.MkdirAll(filepath.Dir(path), 0750); err != nil {
			return r, err
		}
		// Reject symlinked parents, including a directory swapped since inventory.
		for parent := filepath.Dir(path); ; parent = filepath.Dir(parent) {
			info, err := os.Lstat(parent)
			if err != nil {
				return r, err
			}
			if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
				return r, errors.New("unsafe target parent")
			}
			if parent == dst {
				break
			}
			if parent == filepath.Dir(parent) {
				return r, errors.New("target escaped destination")
			}
		}
		if err := copyExclusive(filepath.Join(src, name), path); err != nil {
			return r, err
		}
		hash, err := digest(path)
		if err != nil {
			return r, err
		}
		if hash != source[name] {
			return r, fmt.Errorf("copy checksum mismatch: %s", name)
		}
		r.Copied++
	}
	after, err := inventory(src)
	if err != nil {
		return r, err
	}
	if !reflect.DeepEqual(source, after) {
		return r, errors.New("source changed during copy; keep maintenance enabled")
	}
	verified, err := inventory(dst)
	if err != nil {
		return r, err
	}
	for name, hash := range source {
		if verified[name] != hash {
			return r, fmt.Errorf("final checksum mismatch: %s", name)
		}
	}
	r.Verified = true
	return r, nil
}

func copyExclusive(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0640)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, in)
	syncErr := out.Sync()
	closeErr := out.Close()
	// Incomplete files are left for explicit inspection; never delete/overwrite.
	return errors.Join(copyErr, syncErr, closeErr)
}

func mountPresent(path string) bool {
	b, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(b), "\n") {
		fields := strings.Fields(line)
		if len(fields) > 4 && fields[4] == path {
			return true
		}
	}
	return false
}

func main() {
	apply := flag.Bool("apply", false, "copy missing files; requires stopped application writes")
	flag.Parse()
	if !mountPresent("/data") || !mountPresent("/datav2") {
		fmt.Fprintln(os.Stderr, "both /data and /datav2 must be mounted; refusing migration")
		os.Exit(1)
	}
	if err := os.MkdirAll("/datav2/uploads", 0750); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	r, err := migrate("/data/uploads", "/datav2/uploads", *apply)
	_ = json.NewEncoder(os.Stdout).Encode(r)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
