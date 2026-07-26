// Characterization / regression coverage for sqliteAuditLogRepo.ListByServer,
// whose pagination was changed from a created_at-only cursor to a keyset cursor
// on (created_at, id).
//
// Like sqlite_message.go, ListByServer is hand-written SQL: a boolean-expanded
// keyset (NOT a row-value comparison, for modernc+libsql portability) that
// looks the cursor row's created_at up server-side from its id. The one case
// that motivates the compound cursor — several audit rows sharing a created_at
// second, with a page boundary landing inside that tied group — cannot be
// falsified by a mock, only by paging real rows through the migrated schema.
// The repo is built through wrapForRepo (the production NewRetryingQuerier
// wrapper, exactly like initRepositories) so the retrying querier isn't
// bypassed. DB harness: testdb_test.go.
package repository

import (
	"context"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

const (
	auditServer      = "srv-audit"
	auditOtherServer = "srv-audit-2"
	auditOwner       = "u-audit-owner"
)

// seedAuditWorld plants the FK chain every audit row depends on.
//
// audit_logs.server_id is NOT NULL REFERENCES servers(id) ON DELETE CASCADE and
// database.New enables foreign_keys on the local DSN, so a row cannot insert
// without a real server; servers.owner_id in turn REFERENCES users(id), so an
// owner has to exist first. actor_user_id / target_user_id carry no FK, so they
// are left NULL — the repo's Insert handles nil snapshots and nil actor/target.
func seedAuditWorld(t testing.TB, db *database.DB) {
	t.Helper()
	execSeed(t, db, []seedStmt{
		{`INSERT INTO users (id, username, password_hash) VALUES (?, ?, 'x')`,
			[]any{auditOwner, "audit-owner"}},
		{`INSERT INTO servers (id, name, owner_id) VALUES (?, ?, ?)`,
			[]any{auditServer, "Denetim A", auditOwner}},
		{`INSERT INTO servers (id, name, owner_id) VALUES (?, ?, ?)`,
			[]any{auditOtherServer, "Denetim B", auditOwner}},
	})
}

// newAuditLog writes one audit row through the repo (which generates the id in
// Go) and returns it with its populated ID. eventType is a real enum value so
// nothing relies on an empty/invalid event.
func newAuditLog(t testing.TB, ctx context.Context, repo AuditLogRepository, serverID string, eventType models.AuditEventType) *models.AuditLog {
	t.Helper()
	entry := &models.AuditLog{ServerID: serverID, EventType: eventType}
	if err := repo.Insert(ctx, entry); err != nil {
		t.Fatalf("Insert audit log: %v", err)
	}
	if entry.ID == "" {
		t.Fatal("Insert did not populate the generated id")
	}
	return entry
}

// TestAuditLogRepo_Pagination pins the keyset cursor contract the audit-channel
// UI depends on: newest-first order, the before_id cursor that survives a
// created_at tie, the legacy before-only fallback, and server scoping. Each
// sub-test boots its own migrated DB so their seeded row sets can't contaminate
// one another's counts.
func TestAuditLogRepo_Pagination(t *testing.T) {
	// REGRESSION GUARD — the case the (created_at, id) compound cursor exists
	// for. created_at is second-resolution; id is random hex. Four rows below
	// share the exact same created_at, so a size-2 page boundary is forced to
	// fall inside the tied group. A created_at-only cursor
	// (`created_at < (SELECT created_at ... WHERE id = ?)`) would, once the
	// cursor lands on a tied row, fail the strict `<` for every other row with
	// the SAME created_at — so the next page would skip straight past the rest
	// of the tie and those audit entries would be permanently unreachable via
	// pagination. The compound (created_at, id) cursor must page all four
	// exactly once.
	t.Run("rows sharing a created_at second all survive the before_id page boundary", func(t *testing.T) {
		db := newTestDB(t)
		seedAuditWorld(t, db)
		repo := NewSQLiteAuditLogRepo(wrapForRepo(db))
		ctx := context.Background()

		const tieCount = 4
		tieIDs := make(map[string]bool, tieCount)
		for i := 0; i < tieCount; i++ {
			e := newAuditLog(t, ctx, repo, auditServer, models.AuditEventMemberKick)
			tieIDs[e.ID] = true
			if _, err := db.Conn.Exec(
				`UPDATE audit_logs SET created_at = '2026-01-01 00:01:00' WHERE id = ?`, e.ID,
			); err != nil {
				t.Fatalf("stamp created_at: %v", err)
			}
		}

		// Page in size-2 pages, feeding the last id of each page back as
		// BeforeID (the id of the last row the client holds). A broken cursor
		// would either loop or drop rows, so the iteration is capped.
		seen := make(map[string]int, tieCount)
		var pageSizes []int
		var cursor *string
		for iter := 0; iter < tieCount+2; iter++ {
			filter := models.AuditLogFilter{ServerID: auditServer, Limit: 2}
			filter.BeforeID = cursor
			page, err := repo.ListByServer(ctx, filter)
			if err != nil {
				t.Fatalf("ListByServer page %d: %v", iter, err)
			}
			if len(page) == 0 {
				break
			}
			pageSizes = append(pageSizes, len(page))
			for _, e := range page {
				seen[e.ID]++
			}
			last := page[len(page)-1].ID
			cursor = &last
		}

		// Two full pages of two, then exhaustion — a skip or duplicate at the
		// tied boundary changes these sizes.
		if len(pageSizes) != 2 || pageSizes[0] != 2 || pageSizes[1] != 2 {
			t.Errorf("page sizes = %v, want [2 2] — the before_id cursor lost or repeated a tied row at the boundary", pageSizes)
		}
		for id := range tieIDs {
			if seen[id] != 1 {
				t.Errorf("tied row %s appeared %d time(s) across the pages, want exactly 1 — the before_id cursor skipped or duplicated it", id, seen[id])
			}
		}
		if len(seen) != tieCount {
			t.Errorf("distinct rows paged = %d, want %d", len(seen), tieCount)
		}
	})

	t.Run("first page returns rows newest-first without a cursor", func(t *testing.T) {
		db := newTestDB(t)
		seedAuditWorld(t, db)
		repo := NewSQLiteAuditLogRepo(wrapForRepo(db))
		ctx := context.Background()

		// Distinct-per-second stamps so the ordering assertions are
		// unambiguous (the tie case is covered separately above).
		ids := make([]string, 5)
		for i := range ids {
			e := newAuditLog(t, ctx, repo, auditServer, models.AuditEventMemberKick)
			ids[i] = e.ID
			if _, err := db.Conn.Exec(
				`UPDATE audit_logs SET created_at = datetime('2026-01-01 00:00:0'||?) WHERE id = ?`, i, e.ID,
			); err != nil {
				t.Fatalf("stamp created_at: %v", err)
			}
		}

		got, err := repo.ListByServer(ctx, models.AuditLogFilter{ServerID: auditServer, Limit: 50})
		if err != nil {
			t.Fatalf("ListByServer: %v", err)
		}
		if len(got) != 5 {
			t.Fatalf("entries = %d, want 5", len(got))
		}
		if got[0].ID != ids[4] {
			t.Errorf("first = %s, want the newest %s", got[0].ID, ids[4])
		}
		if got[len(got)-1].ID != ids[0] {
			t.Errorf("last = %s, want the oldest %s", got[len(got)-1].ID, ids[0])
		}
		for i := 1; i < len(got); i++ {
			if got[i].CreatedAt.After(got[i-1].CreatedAt) {
				t.Errorf("row %d (%s) is newer than row %d (%s) — not ordered created_at DESC",
					i, got[i].CreatedAt, i-1, got[i-1].CreatedAt)
			}
		}
		for _, e := range got {
			if e.ServerID != auditServer {
				t.Fatalf("a row from server %s leaked into %s's audit log", e.ServerID, auditServer)
			}
		}

		// Limit is honoured and returns the newest slice.
		page, err := repo.ListByServer(ctx, models.AuditLogFilter{ServerID: auditServer, Limit: 2})
		if err != nil {
			t.Fatalf("ListByServer (limit 2): %v", err)
		}
		if len(page) != 2 || page[0].ID != ids[4] || page[1].ID != ids[3] {
			t.Errorf("limited page = %v, want the two newest [%s %s]", idsOf(page), ids[4], ids[3])
		}
	})

	t.Run("legacy before-only cursor returns strictly older rows", func(t *testing.T) {
		db := newTestDB(t)
		seedAuditWorld(t, db)
		repo := NewSQLiteAuditLogRepo(wrapForRepo(db))
		ctx := context.Background()

		ids := make([]string, 5)
		for i := range ids {
			e := newAuditLog(t, ctx, repo, auditServer, models.AuditEventMemberKick)
			ids[i] = e.ID
			if _, err := db.Conn.Exec(
				`UPDATE audit_logs SET created_at = datetime('2026-01-01 00:00:0'||?) WHERE id = ?`, i, e.ID,
			); err != nil {
				t.Fatalf("stamp created_at: %v", err)
			}
		}

		// Before (no BeforeID) exercises the legacy fallback an older client
		// still sends: a plain `created_at < ?`. The boundary is placed
		// strictly between two rows (…:02.5) rather than on a stamp, so the
		// assertion doesn't hinge on the format-dependent equal-second edge
		// that motivated the id cursor. modernc binds a time.Time via
		// time.Time.String() (default DSN sets no write-time format), so this
		// serialises to "2026-01-01 00:00:02.5 +0000 UTC", which orders after
		// the stored "…:02" and before "…:03".
		before := time.Date(2026, 1, 1, 0, 0, 2, 500000000, time.UTC)
		got, err := repo.ListByServer(ctx, models.AuditLogFilter{ServerID: auditServer, Before: &before, Limit: 50})
		if err != nil {
			t.Fatalf("ListByServer (legacy before): %v", err)
		}
		if len(got) != 3 {
			t.Fatalf("rows older than 00:00:02.5 = %d, want 3 (00,01,02)", len(got))
		}
		older := map[string]bool{ids[0]: true, ids[1]: true, ids[2]: true}
		for _, e := range got {
			if !older[e.ID] {
				t.Errorf("legacy cursor returned %s, not one of the three strictly-older rows", e.ID)
			}
			if e.ID == ids[3] || e.ID == ids[4] {
				t.Errorf("a newer row (%s) came back from the legacy before cursor", e.ID)
			}
		}
	})

	t.Run("another server's rows never leak into a server's audit log", func(t *testing.T) {
		db := newTestDB(t)
		seedAuditWorld(t, db)
		repo := NewSQLiteAuditLogRepo(wrapForRepo(db))
		ctx := context.Background()

		for i := 0; i < 3; i++ {
			newAuditLog(t, ctx, repo, auditServer, models.AuditEventMemberKick)
		}
		other := newAuditLog(t, ctx, repo, auditOtherServer, models.AuditEventMemberBan)

		got, err := repo.ListByServer(ctx, models.AuditLogFilter{ServerID: auditServer, Limit: 50})
		if err != nil {
			t.Fatalf("ListByServer: %v", err)
		}
		if len(got) != 3 {
			t.Errorf("entries = %d, want 3 — the other server's row must be excluded", len(got))
		}
		for _, e := range got {
			if e.ID == other.ID || e.ServerID != auditServer {
				t.Errorf("row from server %s (%s) leaked into %s's audit log", e.ServerID, e.ID, auditServer)
			}
		}
	})
}

// idsOf pulls the ids out of a page for readable failure messages.
func idsOf(entries []models.AuditLog) []string {
	out := make([]string, len(entries))
	for i, e := range entries {
		out[i] = e.ID
	}
	return out
}
