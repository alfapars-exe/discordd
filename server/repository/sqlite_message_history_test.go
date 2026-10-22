// around= / after= history windows for channel and DM messages against a
// real local SQLite database: window shape and ordering, the (created_at,
// id) tiebreak when rows share a second, has_more flags at both edges, and
// the channel-scoped anchor (unknown id or another channel's id → 404).
// DB harness: testdb_test.go.
package repository

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

// seedHistoryChannel creates n messages m0..m(n-1) in channelID with
// created_at stamped so m(i) is at second i — except that every index in
// sameSecond shares the second of the first listed one, which makes the id
// tiebreak load-bearing. Returns the messages in creation order.
func seedHistoryChannel(t *testing.T, db *database.DB, repo MessageRepository, channelID string, n int, sameSecond []int) []*models.Message {
	t.Helper()
	ctx := context.Background()
	out := make([]*models.Message, n)
	for i := 0; i < n; i++ {
		out[i] = newMessage(t, ctx, repo, channelID, msgAuthor, fmt.Sprintf("m%d", i))
	}
	for i := 0; i < n; i++ {
		sec := i
		for _, j := range sameSecond {
			if j == i {
				sec = sameSecond[0]
			}
		}
		if _, err := db.Conn.Exec(`UPDATE messages SET created_at = ? WHERE id = ?`,
			fmt.Sprintf("2026-01-01 00:00:%02d", sec), out[i].ID); err != nil {
			t.Fatalf("stamp created_at: %v", err)
		}
	}
	return out
}

func msgIDsOf(msgs []models.Message) []string {
	ids := make([]string, len(msgs))
	for i, m := range msgs {
		ids[i] = m.ID
	}
	return ids
}

func TestMessageRepo_GetByChannelIDAround(t *testing.T) {
	db := newTestDB(t)
	seedMessageWorld(t, db)
	repo := NewSQLiteMessageRepo(db.Conn)
	ctx := context.Background()

	msgs := seedHistoryChannel(t, db, repo, msgChannel, 9, nil)
	// A message in another channel, a cursor from which must not work here.
	foreign := newMessage(t, ctx, repo, msgOtherChannel, msgAuthor, "elsewhere")

	t.Run("centred window with rows on both sides", func(t *testing.T) {
		got, before, after, err := repo.GetByChannelIDAround(ctx, msgChannel, msgs[4].ID, 4)
		if err != nil {
			t.Fatalf("GetByChannelIDAround: %v", err)
		}
		want := []string{msgs[2].ID, msgs[3].ID, msgs[4].ID, msgs[5].ID, msgs[6].ID}
		if fmt.Sprint(msgIDsOf(got)) != fmt.Sprint(want) {
			t.Errorf("window = %v, want %v (2 older, anchor, 2 newer, ASC)", msgIDsOf(got), want)
		}
		if !before || !after {
			t.Errorf("has_more = (%v, %v), want (true, true)", before, after)
		}
	})

	t.Run("anchor at the oldest edge", func(t *testing.T) {
		got, before, after, err := repo.GetByChannelIDAround(ctx, msgChannel, msgs[0].ID, 4)
		if err != nil {
			t.Fatalf("GetByChannelIDAround: %v", err)
		}
		if got[0].ID != msgs[0].ID || len(got) != 3 {
			t.Errorf("window = %v, want anchor first then 2 newer", msgIDsOf(got))
		}
		if before || !after {
			t.Errorf("has_more = (%v, %v), want (false, true)", before, after)
		}
	})

	t.Run("anchor at the newest edge", func(t *testing.T) {
		got, before, after, err := repo.GetByChannelIDAround(ctx, msgChannel, msgs[8].ID, 4)
		if err != nil {
			t.Fatalf("GetByChannelIDAround: %v", err)
		}
		if got[len(got)-1].ID != msgs[8].ID || len(got) != 3 {
			t.Errorf("window = %v, want 2 older then the anchor", msgIDsOf(got))
		}
		if !before || after {
			t.Errorf("has_more = (%v, %v), want (true, false)", before, after)
		}
	})

	t.Run("window exactly fits: no more on either side", func(t *testing.T) {
		got, before, after, err := repo.GetByChannelIDAround(ctx, msgChannel, msgs[4].ID, 8)
		if err != nil {
			t.Fatalf("GetByChannelIDAround: %v", err)
		}
		if len(got) != 9 || before || after {
			t.Errorf("window = %d rows, has_more = (%v, %v); want 9, (false, false)", len(got), before, after)
		}
	})

	t.Run("unknown anchor is not found", func(t *testing.T) {
		_, _, _, err := repo.GetByChannelIDAround(ctx, msgChannel, "no-such-message", 4)
		if !errors.Is(err, pkg.ErrNotFound) {
			t.Errorf("err = %v, want ErrNotFound", err)
		}
	})

	t.Run("another channel's message is not an anchor here", func(t *testing.T) {
		_, _, _, err := repo.GetByChannelIDAround(ctx, msgChannel, foreign.ID, 4)
		if !errors.Is(err, pkg.ErrNotFound) {
			t.Errorf("err = %v, want ErrNotFound (anchor must be channel-scoped)", err)
		}
	})
}

// TestMessageRepo_GetByChannelIDAround_SameSecondTiebreak — created_at has
// second resolution, so several messages can share it; the window must then
// split on id exactly as the before= cursor does, so no row is skipped or
// duplicated across the anchor.
func TestMessageRepo_GetByChannelIDAround_SameSecondTiebreak(t *testing.T) {
	db := newTestDB(t)
	seedMessageWorld(t, db)
	repo := NewSQLiteMessageRepo(db.Conn)
	ctx := context.Background()

	// m2..m6 all share second 2.
	msgs := seedHistoryChannel(t, db, repo, msgChannel, 9, []int{2, 3, 4, 5, 6})

	// Expected ASC order inside the tie is id ASC — compute it from the
	// ids themselves rather than assuming creation order.
	tie := []*models.Message{msgs[2], msgs[3], msgs[4], msgs[5], msgs[6]}
	for i := 0; i < len(tie); i++ {
		for j := i + 1; j < len(tie); j++ {
			if tie[j].ID < tie[i].ID {
				tie[i], tie[j] = tie[j], tie[i]
			}
		}
	}
	anchor := tie[2] // the middle of the tie

	got, before, after, err := repo.GetByChannelIDAround(ctx, msgChannel, anchor.ID, 4)
	if err != nil {
		t.Fatalf("GetByChannelIDAround: %v", err)
	}
	want := []string{tie[0].ID, tie[1].ID, tie[2].ID, tie[3].ID, tie[4].ID}
	if fmt.Sprint(msgIDsOf(got)) != fmt.Sprint(want) {
		t.Errorf("window = %v, want %v (id ASC inside the shared second)", msgIDsOf(got), want)
	}
	if !before || !after {
		t.Errorf("has_more = (%v, %v), want (true, true) — m0/m1 older, m7/m8 newer", before, after)
	}

	// Walking the whole channel with after= from the oldest row must visit
	// every message exactly once, ties included.
	var walked []string
	cursor := msgs[0].ID
	walked = append(walked, cursor)
	for {
		page, err := repo.GetByChannelIDAfter(ctx, msgChannel, cursor, 3)
		if err != nil {
			t.Fatalf("GetByChannelIDAfter: %v", err)
		}
		if len(page) == 0 {
			break
		}
		for _, m := range page {
			walked = append(walked, m.ID)
		}
		cursor = page[len(page)-1].ID
	}
	seen := map[string]int{}
	for _, id := range walked {
		seen[id]++
	}
	for _, m := range msgs {
		if seen[m.ID] != 1 {
			t.Errorf("after= walk saw %s %d time(s), want exactly 1", m.ID, seen[m.ID])
		}
	}
	if len(walked) != len(msgs) {
		t.Errorf("after= walk visited %d rows, want %d", len(walked), len(msgs))
	}
}

func TestMessageRepo_GetByChannelIDAfter(t *testing.T) {
	db := newTestDB(t)
	seedMessageWorld(t, db)
	repo := NewSQLiteMessageRepo(db.Conn)
	ctx := context.Background()

	msgs := seedHistoryChannel(t, db, repo, msgChannel, 5, nil)
	foreign := newMessage(t, ctx, repo, msgOtherChannel, msgAuthor, "elsewhere")

	got, err := repo.GetByChannelIDAfter(ctx, msgChannel, msgs[1].ID, 2)
	if err != nil {
		t.Fatalf("GetByChannelIDAfter: %v", err)
	}
	want := []string{msgs[2].ID, msgs[3].ID}
	if fmt.Sprint(msgIDsOf(got)) != fmt.Sprint(want) {
		t.Errorf("after page = %v, want %v (strictly newer, ASC, limited)", msgIDsOf(got), want)
	}

	got, err = repo.GetByChannelIDAfter(ctx, msgChannel, msgs[4].ID, 10)
	if err != nil {
		t.Fatalf("GetByChannelIDAfter(newest): %v", err)
	}
	if len(got) != 0 {
		t.Errorf("after newest = %v, want empty", msgIDsOf(got))
	}

	if _, err := repo.GetByChannelIDAfter(ctx, msgChannel, "no-such-message", 10); !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("unknown anchor err = %v, want ErrNotFound", err)
	}
	if _, err := repo.GetByChannelIDAfter(ctx, msgChannel, foreign.ID, 10); !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("foreign anchor err = %v, want ErrNotFound", err)
	}
}

// ─── DM twins ───

func seedDMHistory(t *testing.T, db *database.DB, repo DMRepository, channelID string, n int) []*models.DMMessage {
	t.Helper()
	ctx := context.Background()
	out := make([]*models.DMMessage, n)
	for i := 0; i < n; i++ {
		out[i] = newDMMessage(t, ctx, repo, channelID, dmAlice, fmt.Sprintf("d%d", i))
		if _, err := db.Conn.Exec(`UPDATE dm_messages SET created_at = ? WHERE id = ?`,
			fmt.Sprintf("2026-01-01 00:00:%02d", i), out[i].ID); err != nil {
			t.Fatalf("stamp created_at: %v", err)
		}
	}
	return out
}

func dmIDsOf(msgs []models.DMMessage) []string {
	ids := make([]string, len(msgs))
	for i, m := range msgs {
		ids[i] = m.ID
	}
	return ids
}

func TestDMRepo_GetMessagesAroundAndAfter(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	repo := NewSQLiteDMRepo(db.Conn)
	ctx := context.Background()

	ch := newDMChannel(t, ctx, repo, dmAlice, dmBob, models.DMStatusAccepted)
	other := newDMChannel(t, ctx, repo, dmAlice, dmCarol, models.DMStatusAccepted)
	msgs := seedDMHistory(t, db, repo, ch.ID, 7)
	foreign := newDMMessage(t, ctx, repo, other.ID, dmAlice, "elsewhere")

	got, before, after, err := repo.GetMessagesAround(ctx, ch.ID, msgs[3].ID, 4)
	if err != nil {
		t.Fatalf("GetMessagesAround: %v", err)
	}
	want := []string{msgs[1].ID, msgs[2].ID, msgs[3].ID, msgs[4].ID, msgs[5].ID}
	if fmt.Sprint(dmIDsOf(got)) != fmt.Sprint(want) {
		t.Errorf("window = %v, want %v", dmIDsOf(got), want)
	}
	if !before || !after {
		t.Errorf("has_more = (%v, %v), want (true, true)", before, after)
	}
	if got[2].Author == nil || got[2].Author.ID != dmAlice {
		t.Errorf("author not joined on the window rows: %+v", got[2].Author)
	}

	got, before, after, err = repo.GetMessagesAround(ctx, ch.ID, msgs[0].ID, 4)
	if err != nil {
		t.Fatalf("GetMessagesAround(oldest): %v", err)
	}
	if len(got) != 3 || got[0].ID != msgs[0].ID || before || !after {
		t.Errorf("oldest-edge window = %v, has_more (%v, %v)", dmIDsOf(got), before, after)
	}

	for _, anchor := range []string{"no-such-dm-message", foreign.ID} {
		if _, _, _, err := repo.GetMessagesAround(ctx, ch.ID, anchor, 4); !errors.Is(err, pkg.ErrNotFound) {
			t.Errorf("GetMessagesAround(anchor %q) err = %v, want ErrNotFound", anchor, err)
		}
		if _, err := repo.GetMessagesAfter(ctx, ch.ID, anchor, 4); !errors.Is(err, pkg.ErrNotFound) {
			t.Errorf("GetMessagesAfter(anchor %q) err = %v, want ErrNotFound", anchor, err)
		}
	}

	page, err := repo.GetMessagesAfter(ctx, ch.ID, msgs[4].ID, 10)
	if err != nil {
		t.Fatalf("GetMessagesAfter: %v", err)
	}
	if fmt.Sprint(dmIDsOf(page)) != fmt.Sprint([]string{msgs[5].ID, msgs[6].ID}) {
		t.Errorf("after page = %v, want the two newest", dmIDsOf(page))
	}
	empty, err := repo.GetMessagesAfter(ctx, ch.ID, msgs[6].ID, 10)
	if err != nil || empty == nil || len(empty) != 0 {
		t.Errorf("after newest = %v (%v), want empty non-nil", empty, err)
	}
}

// TestBeforeCursor_ForeignIDBehavesLikeUnknown — the before= cursor
// subqueries are channel-scoped, so another channel's message id yields the
// same (empty) page as an id that does not exist, instead of lending its
// timestamp to this channel's page boundary.
func TestBeforeCursor_ForeignIDBehavesLikeUnknown(t *testing.T) {
	ctx := context.Background()

	t.Run("channel", func(t *testing.T) {
		db := newTestDB(t)
		seedMessageWorld(t, db)
		repo := NewSQLiteMessageRepo(db.Conn)
		msgs := seedHistoryChannel(t, db, repo, msgChannel, 3, nil)
		foreign := newMessage(t, ctx, repo, msgOtherChannel, msgAuthor, "elsewhere")
		if _, err := db.Conn.Exec(`UPDATE messages SET created_at = '2026-01-01 00:00:59' WHERE id = ?`, foreign.ID); err != nil {
			t.Fatalf("stamp: %v", err)
		}

		viaForeign, err := repo.GetByChannelID(ctx, msgChannel, foreign.ID, 10)
		if err != nil {
			t.Fatalf("GetByChannelID(foreign cursor): %v", err)
		}
		viaUnknown, err := repo.GetByChannelID(ctx, msgChannel, "no-such-message", 10)
		if err != nil {
			t.Fatalf("GetByChannelID(unknown cursor): %v", err)
		}
		if len(viaForeign) != 0 || len(viaUnknown) != 0 {
			t.Errorf("foreign cursor → %d rows, unknown → %d rows; want 0 and 0", len(viaForeign), len(viaUnknown))
		}
		own, err := repo.GetByChannelID(ctx, msgChannel, msgs[2].ID, 10)
		if err != nil || len(own) != 2 {
			t.Errorf("own cursor = %d rows (%v), want 2", len(own), err)
		}
	})

	t.Run("dm", func(t *testing.T) {
		db := newTestDB(t)
		seedDMUsers(t, db)
		repo := NewSQLiteDMRepo(db.Conn)
		ch := newDMChannel(t, ctx, repo, dmAlice, dmBob, models.DMStatusAccepted)
		other := newDMChannel(t, ctx, repo, dmAlice, dmCarol, models.DMStatusAccepted)
		msgs := seedDMHistory(t, db, repo, ch.ID, 3)
		foreign := newDMMessage(t, ctx, repo, other.ID, dmAlice, "elsewhere")
		if _, err := db.Conn.Exec(`UPDATE dm_messages SET created_at = '2026-01-01 00:00:59' WHERE id = ?`, foreign.ID); err != nil {
			t.Fatalf("stamp: %v", err)
		}

		viaForeign, err := repo.GetMessages(ctx, ch.ID, foreign.ID, 10)
		if err != nil {
			t.Fatalf("GetMessages(foreign cursor): %v", err)
		}
		viaUnknown, err := repo.GetMessages(ctx, ch.ID, "no-such-dm-message", 10)
		if err != nil {
			t.Fatalf("GetMessages(unknown cursor): %v", err)
		}
		if len(viaForeign) != 0 || len(viaUnknown) != 0 {
			t.Errorf("foreign cursor → %d rows, unknown → %d rows; want 0 and 0", len(viaForeign), len(viaUnknown))
		}
		own, err := repo.GetMessages(ctx, ch.ID, msgs[2].ID, 10)
		if err != nil || len(own) != 2 {
			t.Errorf("own cursor = %d rows (%v), want 2", len(own), err)
		}
	})
}
