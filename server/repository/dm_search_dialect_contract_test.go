package repository

import (
	"context"
	"github.com/argeinfina/hichat/models"
	"testing"
)

// Shared result contract; SQLite relevance and PostgreSQL ILIKE are not
// asserted identical. Equal-content rows isolate channel and page semantics.
func TestDMSearchDialectContractChannelCountAndPages(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	ctx := context.Background()
	repo := NewSQLiteDMRepo(wrapForRepo(db))
	channel := newDMChannel(t, ctx, repo, dmAlice, dmBob, models.DMStatusAccepted)
	other := newDMChannel(t, ctx, repo, dmAlice, dmCarol, models.DMStatusAccepted)
	ids := []string{}
	for _, ch := range []string{channel.ID, channel.ID, other.ID} {
		message := &models.DMMessage{DMChannelID: ch, UserID: dmAlice, Content: ptrString("dialectsearchfixture")}
		if err := repo.CreateMessage(ctx, message); err != nil {
			t.Fatal(err)
		}
		if ch == channel.ID {
			ids = append(ids, message.ID)
		}
	}
	for offset := 0; offset < 3; offset++ {
		rows, count, err := repo.SearchMessages(ctx, channel.ID, "dialectsearchfixture", 1, offset)
		if err != nil || count != 2 {
			t.Fatalf("page %d count=%d err=%v", offset, count, err)
		}
		if offset == 2 {
			if len(rows) != 0 {
				t.Fatalf("past-end page: %+v", rows)
			}
		} else if len(rows) != 1 || rows[0].ID != ids[1-offset] || rows[0].DMChannelID != channel.ID || rows[0].SourceSequence <= 0 {
			t.Fatalf("page %d: %+v", offset, rows)
		}
	}
	for _, query := range []string{"", "absentfixture"} {
		rows, count, err := repo.SearchMessages(ctx, channel.ID, query, 10, 0)
		if err != nil || count != 0 || len(rows) != 0 {
			t.Fatalf("empty search %q: %d/%d %v", query, len(rows), count, err)
		}
	}
}
