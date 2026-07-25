// Benchmarks for sqliteMessageRepo.GetByChannelID against a ~1000-row
// channel history — first page (no cursor) vs. the cursor branch (compound
// created_at/id boolean expansion sub-select).
//
// Reuses the real-SQLite harness (testdb_test.go) and message fixtures
// (sqlite_message_test.go) the correctness tests already use rather than
// inventing a mock — repository code is almost entirely SQL, and only
// running it against the real migrated schema is meaningful here.
package repository

import (
	"context"
	"fmt"
	"testing"

	"github.com/argeinfina/hichat/database"
)

// benchMessageCount is the fixture size for the pagination benchmarks below:
// large enough that GetByChannelID's WHERE/ORDER BY has a real row set to
// filter, small enough that building the fixture (outside the timed loop)
// stays fast.
const benchMessageCount = 1000

// seedMessageBenchWorld inserts benchMessageCount messages into msgChannel
// through the real repo (so Create's id generation and column list are
// exercised, same as the correctness tests) and spreads their created_at one
// second apart so GetByChannelID's ORDER BY has a real range to page
// through, returning the ids in insertion (oldest-first) order.
//
// created_at is stamped through SQLite's own datetime() function — never by
// binding a Go time.Time — same rule as TestMessageRepo_Pagination above:
// the column's DEFAULT is CURRENT_TIMESTAMP, which SQLite writes in its own
// "YYYY-MM-DD HH:MM:SS" format, and a bound time.Time value would instead
// land as RFC3339. Mixing the two formats in one column silently breaks
// string-ordered comparisons. The pagination test's literal digit-suffix
// form only covers single-digit offsets; this uses datetime()'s "+N seconds"
// modifier instead so it scales to benchMessageCount rows while keeping the
// same "let SQLite format the string" discipline.
func seedMessageBenchWorld(b *testing.B, db *database.DB, repo MessageRepository) []string {
	b.Helper()
	ctx := context.Background()

	ids := make([]string, benchMessageCount)
	for i := 0; i < benchMessageCount; i++ {
		msg := newMessage(b, ctx, repo, msgChannel, msgAuthor, fmt.Sprintf("bench message %d", i))
		if _, err := db.Conn.Exec(
			`UPDATE messages SET created_at = datetime('2026-01-01 00:00:00', '+' || ? || ' seconds') WHERE id = ?`,
			i, msg.ID,
		); err != nil {
			b.Fatalf("stamp created_at: %v", err)
		}
		ids[i] = msg.ID
	}
	return ids
}

// BenchmarkMessageRepo_GetByChannelID_FirstPage measures the no-cursor
// branch (beforeID=""): newest-N straight off the (channel_id, created_at,
// id) ordering, no cursor sub-select.
func BenchmarkMessageRepo_GetByChannelID_FirstPage(b *testing.B) {
	db := newTestDB(b)
	seedMessageWorld(b, db)
	repo := NewSQLiteMessageRepo(db.Conn)
	seedMessageBenchWorld(b, db, repo)
	ctx := context.Background()

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := repo.GetByChannelID(ctx, msgChannel, "", 50); err != nil {
			b.Fatalf("GetByChannelID: %v", err)
		}
	}
}

// BenchmarkMessageRepo_GetByChannelID_Cursor measures the cursor branch
// (beforeID set to a message roughly in the middle of the fixture), which
// adds the two correlated sub-selects the FirstPage benchmark above never
// exercises. Run sequentially (not b.RunParallel) — this measures per-query
// cost, not connection-pool contention; the pool is deliberately small
// (MaxOpenConns(4)/MaxIdleConns(2)) and isn't the thing under test here.
func BenchmarkMessageRepo_GetByChannelID_Cursor(b *testing.B) {
	db := newTestDB(b)
	seedMessageWorld(b, db)
	repo := NewSQLiteMessageRepo(db.Conn)
	ids := seedMessageBenchWorld(b, db, repo)
	cursor := ids[len(ids)/2]
	ctx := context.Background()

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := repo.GetByChannelID(ctx, msgChannel, cursor, 50); err != nil {
			b.Fatalf("GetByChannelID: %v", err)
		}
	}
}
