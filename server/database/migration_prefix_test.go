// Migration numeric-prefix guard (P1.14) — migrations are append-only and
// numbered by hand, so two people (or two branches) picking the same next
// number is a real, recurring hazard: "072" already collided once
// (072_attachments_file_url_unique.sql and 072_bot_accounts.sql, both
// already applied in production, so renumbering either is not safe). This
// test fails the build the moment a NEW collision is introduced, instead of
// it being discovered at merge time or — worse — at deploy time when the
// runner applies both files in whatever order fs.ReadDir happens to return.
package database

import (
	"io/fs"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// allowedDuplicatePrefixes lists migration numeric prefixes that
// legitimately collide. Only "072" right now (see this file's top doc
// comment for why it can't just be renumbered). To find the next free
// prefix instead of colliding: `ls database/migrations | sort | tail`.
var allowedDuplicatePrefixes = map[string]bool{
	"072": true,
}

var migrationPrefixRe = regexp.MustCompile(`^(\d+)_`)

func TestMigrationPrefixes_NoAccidentalDuplicates(t *testing.T) {
	entries, err := fs.ReadDir(EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatalf("read embedded migrations dir: %v", err)
	}

	byPrefix := make(map[string][]string)
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if !strings.HasSuffix(name, ".sql") {
			continue
		}
		m := migrationPrefixRe.FindStringSubmatch(name)
		if m == nil {
			t.Errorf("migration file %q does not start with a numeric prefix (NNN_name.sql)", name)
			continue
		}
		prefix := m[1]
		byPrefix[prefix] = append(byPrefix[prefix], name)
	}

	if len(byPrefix) == 0 {
		t.Fatal("no migration files found under migrations/ — wrong embed path?")
	}

	var prefixes []string
	for p := range byPrefix {
		prefixes = append(prefixes, p)
	}
	sort.Strings(prefixes)

	for _, prefix := range prefixes {
		files := byPrefix[prefix]
		if len(files) <= 1 {
			continue
		}
		sort.Strings(files)
		if allowedDuplicatePrefixes[prefix] {
			continue
		}
		t.Errorf("migration prefix %q is used by %d files (%s) — pick the next free prefix instead of reusing one "+
			"already in use (`ls database/migrations | sort | tail` to find it); if this collision is intentional "+
			"and already deployed (like 072), add it to allowedDuplicatePrefixes with a reason", prefix, len(files), strings.Join(files, ", "))
	}

	// Stale-allowlist guard: an allowedDuplicatePrefixes entry for a prefix
	// that's no longer duplicated (one of the two files got renamed/merged)
	// means nobody re-validated the entry against the current file set.
	for prefix := range allowedDuplicatePrefixes {
		if len(byPrefix[prefix]) <= 1 {
			t.Errorf("allowedDuplicatePrefixes has a stale entry for %q — no longer duplicated in migrations/", prefix)
		}
	}
}
