// sqliteNotificationRepo against a real local SQLite database (migration
// 082): insert shape, actor LEFT JOIN, keyset pagination, ownership-scoped
// mark-read, and the message-delete cleanup. DB harness: testdb_test.go.
package repository

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

func TestNotificationRepo_CreateAndList(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	repo := NewSQLiteNotificationRepo(wrapForRepo(db))
	ctx := context.Background()

	actor := dmAlice
	n := &models.Notification{
		UserID:  dmBob,
		Kind:    models.NotificationKindMention,
		ActorID: &actor,
		Payload: json.RawMessage(`{"preview":"selam","channel_name":"genel"}`),
	}
	if err := repo.Create(ctx, n); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if n.ID == "" {
		t.Fatal("Create did not populate the generated ID")
	}
	// API boundary: the stored 'YYYY-MM-DD HH:MM:SS' text must leave as
	// RFC3339 UTC ('...Z'), on the Create read-back and on List alike.
	assertRFC3339UTC(t, "Create read-back created_at", n.CreatedAt)

	// Empty payload is stored as '{}' — never NULL/"" that would break JSON.
	empty := &models.Notification{UserID: dmBob, Kind: models.NotificationKindDMRequest}
	if err := repo.Create(ctx, empty); err != nil {
		t.Fatalf("Create(empty payload): %v", err)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM notifications WHERE id = ? AND payload = '{}'`, empty.ID); n != 1 {
		t.Errorf("empty payload was not stored as '{}'")
	}

	list, err := repo.List(ctx, dmBob, "", false, 10)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("list = %d rows, want 2", len(list))
	}
	var got *models.Notification
	for i := range list {
		if list[i].ID == n.ID {
			got = &list[i]
		}
	}
	if got == nil {
		t.Fatal("created notification missing from List")
	}
	if got.Actor == nil || got.Actor.ID != dmAlice || got.Actor.Username != "alice" {
		t.Errorf("actor = %+v, want alice's public view", got.Actor)
	}
	if got.ReadAt != nil {
		t.Errorf("read_at = %v, want nil on a fresh row", *got.ReadAt)
	}
	assertRFC3339UTC(t, "List created_at", got.CreatedAt)
	if string(got.Payload) != `{"preview":"selam","channel_name":"genel"}` {
		t.Errorf("payload = %s", got.Payload)
	}

	// Other users never see Bob's inbox.
	aliceList, err := repo.List(ctx, dmAlice, "", false, 10)
	if err != nil {
		t.Fatalf("List(alice): %v", err)
	}
	if len(aliceList) != 0 {
		t.Errorf("alice sees %d of bob's notifications, want 0", len(aliceList))
	}
}

// TestNotificationRepo_DeletedActorYieldsNilActor — the users LEFT JOIN
// must not fail the row when actor_id points at a vanished user.
func TestNotificationRepo_DeletedActorYieldsNilActor(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	repo := NewSQLiteNotificationRepo(db.Conn)
	ctx := context.Background()

	ghost := "u-ghost"
	n := &models.Notification{UserID: dmBob, Kind: models.NotificationKindReply, ActorID: &ghost}
	if err := repo.Create(ctx, n); err != nil {
		t.Fatalf("Create: %v", err)
	}
	list, err := repo.List(ctx, dmBob, "", false, 10)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("list = %d rows, want 1", len(list))
	}
	if list[0].Actor != nil {
		t.Errorf("actor = %+v, want nil for a missing user", list[0].Actor)
	}
	if list[0].ActorID == nil || *list[0].ActorID != ghost {
		t.Errorf("actor_id = %v, want %q preserved", list[0].ActorID, ghost)
	}
}

func TestNotificationRepo_KeysetPagination(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	repo := NewSQLiteNotificationRepo(db.Conn)
	ctx := context.Background()

	// Five rows with distinct created_at, ids chosen so id order and time
	// order DISAGREE: a cursor that sorted by id alone would come out wrong.
	rows := []struct{ id, createdAt string }{
		{"n-e", "2026-01-01 10:00:01"},
		{"n-d", "2026-01-01 10:00:02"},
		{"n-c", "2026-01-01 10:00:03"},
		{"n-b", "2026-01-01 10:00:03"}, // ties with n-c: id DESC breaks it
		{"n-a", "2026-01-01 10:00:05"},
	}
	for _, r := range rows {
		execSeed(t, db, []seedStmt{{
			`INSERT INTO notifications (id, user_id, kind, created_at) VALUES (?, ?, 'mention', ?)`,
			[]any{r.id, dmBob, r.createdAt},
		}})
	}

	page1, err := repo.List(ctx, dmBob, "", false, 2)
	if err != nil {
		t.Fatalf("List page1: %v", err)
	}
	if got := notificationIDs(page1); got != "n-a,n-c" {
		t.Fatalf("page1 = %s, want n-a,n-c (newest first, id DESC on ties)", got)
	}

	page2, err := repo.List(ctx, dmBob, page1[len(page1)-1].ID, false, 2)
	if err != nil {
		t.Fatalf("List page2: %v", err)
	}
	if got := notificationIDs(page2); got != "n-b,n-d" {
		t.Fatalf("page2 = %s, want n-b,n-d (tie-broken continuation)", got)
	}

	page3, err := repo.List(ctx, dmBob, page2[len(page2)-1].ID, false, 2)
	if err != nil {
		t.Fatalf("List page3: %v", err)
	}
	if got := notificationIDs(page3); got != "n-e" {
		t.Fatalf("page3 = %s, want n-e", got)
	}

	// Unknown cursor: empty page, not an error.
	none, err := repo.List(ctx, dmBob, "does-not-exist", false, 2)
	if err != nil {
		t.Fatalf("List(unknown cursor): %v", err)
	}
	if len(none) != 0 {
		t.Errorf("unknown cursor returned %d rows, want 0", len(none))
	}
}

func notificationIDs(list []models.Notification) string {
	out := ""
	for i, n := range list {
		if i > 0 {
			out += ","
		}
		out += n.ID
	}
	return out
}

func TestNotificationRepo_MarkReadAndCounts(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	repo := NewSQLiteNotificationRepo(db.Conn)
	ctx := context.Background()

	var created []string
	for i := 0; i < 3; i++ {
		n := &models.Notification{UserID: dmBob, Kind: models.NotificationKindMention}
		if err := repo.Create(ctx, n); err != nil {
			t.Fatalf("Create: %v", err)
		}
		created = append(created, n.ID)
	}
	other := &models.Notification{UserID: dmAlice, Kind: models.NotificationKindMention}
	if err := repo.Create(ctx, other); err != nil {
		t.Fatalf("Create(other): %v", err)
	}

	if n, _ := repo.CountUnread(ctx, dmBob); n != 3 {
		t.Fatalf("CountUnread = %d, want 3", n)
	}

	t.Run("mark read is ownership scoped", func(t *testing.T) {
		ok, err := repo.MarkRead(ctx, dmAlice, created[0])
		if err != nil {
			t.Fatalf("MarkRead(wrong owner): %v", err)
		}
		if ok {
			t.Error("another user could mark bob's notification as read")
		}
		ok, err = repo.MarkRead(ctx, dmBob, "nope")
		if err != nil {
			t.Fatalf("MarkRead(unknown): %v", err)
		}
		if ok {
			t.Error("unknown id reported as marked")
		}
		ok, err = repo.MarkRead(ctx, dmBob, created[0])
		if err != nil {
			t.Fatalf("MarkRead: %v", err)
		}
		if !ok {
			t.Fatal("owner mark-read reported no match")
		}
		if n, _ := repo.CountUnread(ctx, dmBob); n != 2 {
			t.Errorf("CountUnread after one mark = %d, want 2", n)
		}
	})

	t.Run("repeat mark read keeps the original read_at and still matches", func(t *testing.T) {
		var first string
		if err := db.Conn.QueryRow(`SELECT read_at FROM notifications WHERE id = ?`, created[0]).Scan(&first); err != nil {
			t.Fatalf("read read_at: %v", err)
		}
		if _, err := db.Conn.Exec(`UPDATE notifications SET read_at = '2000-01-01 00:00:00' WHERE id = ?`, created[0]); err != nil {
			t.Fatalf("backdate read_at: %v", err)
		}
		ok, err := repo.MarkRead(ctx, dmBob, created[0])
		if err != nil || !ok {
			t.Fatalf("repeat MarkRead = (%v, %v), want (true, nil)", ok, err)
		}
		var again string
		if err := db.Conn.QueryRow(`SELECT read_at FROM notifications WHERE id = ?`, created[0]).Scan(&again); err != nil {
			t.Fatalf("read read_at: %v", err)
		}
		if dbTextToRFC3339(again) != "2000-01-01T00:00:00Z" {
			t.Errorf("repeat mark-read overwrote read_at: %q", again)
		}
	})

	t.Run("unread_only filter", func(t *testing.T) {
		list, err := repo.List(ctx, dmBob, "", true, 10)
		if err != nil {
			t.Fatalf("List(unread only): %v", err)
		}
		if len(list) != 2 {
			t.Errorf("unread-only list = %d, want 2", len(list))
		}
		for _, n := range list {
			if n.ReadAt != nil {
				t.Errorf("read row %s leaked into unread-only list", n.ID)
			}
		}
	})

	t.Run("mark all read", func(t *testing.T) {
		marked, err := repo.MarkAllRead(ctx, dmBob)
		if err != nil {
			t.Fatalf("MarkAllRead: %v", err)
		}
		if marked != 2 {
			t.Errorf("marked = %d, want 2 (one was already read)", marked)
		}
		if n, _ := repo.CountUnread(ctx, dmBob); n != 0 {
			t.Errorf("CountUnread after mark-all = %d, want 0", n)
		}
		if n, _ := repo.CountUnread(ctx, dmAlice); n != 1 {
			t.Errorf("alice's unread count changed to %d, want 1 (mark-all must be per-user)", n)
		}
	})
}

func TestNotificationRepo_DeleteByMessageID(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	repo := NewSQLiteNotificationRepo(db.Conn)
	ctx := context.Background()

	msg := "m-1"
	keep := "m-2"
	for _, mid := range []string{msg, msg, keep} {
		m := mid
		if err := repo.Create(ctx, &models.Notification{UserID: dmBob, Kind: models.NotificationKindMention, MessageID: &m}); err != nil {
			t.Fatalf("Create: %v", err)
		}
	}
	if err := repo.DeleteByMessageID(ctx, msg); err != nil {
		t.Fatalf("DeleteByMessageID: %v", err)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM notifications WHERE message_id = ?`, msg); n != 0 {
		t.Errorf("%d notifications survived for the deleted message", n)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM notifications WHERE message_id = ?`, keep); n != 1 {
		t.Errorf("notification for another message was removed (got %d, want 1)", n)
	}
}

// assertRFC3339UTC — the API/WS boundary contract for notification
// timestamps: RFC3339 with a 'Z' suffix (never the raw 'YYYY-MM-DD HH:MM:SS'
// text, which browsers parse as local time or NaN).
func assertRFC3339UTC(t *testing.T, label, value string) {
	t.Helper()
	if !strings.HasSuffix(value, "Z") {
		t.Errorf("%s = %q, want an RFC3339 UTC string ending in Z", label, value)
		return
	}
	if _, err := time.Parse(time.RFC3339, value); err != nil {
		t.Errorf("%s = %q does not parse as RFC3339: %v", label, value, err)
	}
}

func TestNotificationRepo_ReadAtIsRFC3339(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	repo := NewSQLiteNotificationRepo(db.Conn)
	ctx := context.Background()

	n := &models.Notification{UserID: dmBob, Kind: models.NotificationKindMention}
	if err := repo.Create(ctx, n); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := repo.MarkRead(ctx, dmBob, n.ID); err != nil {
		t.Fatalf("MarkRead: %v", err)
	}
	list, err := repo.List(ctx, dmBob, "", false, 10)
	if err != nil || len(list) != 1 {
		t.Fatalf("List = (%d rows, %v), want 1 row", len(list), err)
	}
	if list[0].ReadAt == nil {
		t.Fatal("read_at nil after MarkRead")
	}
	assertRFC3339UTC(t, "List read_at", *list[0].ReadAt)
	if database.IsPostgres(wrapForRepo(db)) {
		var createdType, readType string
		if err := db.Conn.QueryRow(`SELECT pg_typeof(created_at)::text,pg_typeof(read_at)::text FROM notifications WHERE id=?`, n.ID).Scan(&createdType, &readType); err != nil {
			t.Fatal(err)
		}
		if createdType != "timestamp with time zone" || readType != "timestamp with time zone" {
			t.Fatalf("PostgreSQL timestamp storage types=%s/%s", createdType, readType)
		}
	} else {
		// SQLite stores UTC space-separated text; the public boundary converts it.
		if n := countRows(t, db, `SELECT COUNT(*) FROM notifications WHERE id = ? AND created_at LIKE '____-__-__ __:__:__' AND read_at LIKE '____-__-__ __:__:__'`, n.ID); n != 1 {
			t.Error("stored created_at/read_at are not 'YYYY-MM-DD HH:MM:SS' text")
		}
	}
}

// TestNotificationRepo_CursorIsScopedToCaller — another user's notification
// id used as `before` must behave exactly like an unknown id (empty page),
// so the cursor cannot be used to probe foreign rows' timestamps.
func TestNotificationRepo_CursorIsScopedToCaller(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	repo := NewSQLiteNotificationRepo(db.Conn)
	ctx := context.Background()

	execSeed(t, db, []seedStmt{
		{`INSERT INTO notifications (id, user_id, kind, created_at) VALUES ('bob-old', ?, 'mention', '2026-01-01 10:00:00')`, []any{dmBob}},
		{`INSERT INTO notifications (id, user_id, kind, created_at) VALUES ('bob-new', ?, 'mention', '2026-01-01 10:00:05')`, []any{dmBob}},
		{`INSERT INTO notifications (id, user_id, kind, created_at) VALUES ('alice-mid', ?, 'mention', '2026-01-01 10:00:03')`, []any{dmAlice}},
	})

	foreign, err := repo.List(ctx, dmBob, "alice-mid", false, 10)
	if err != nil {
		t.Fatalf("List(foreign cursor): %v", err)
	}
	unknown, err := repo.List(ctx, dmBob, "no-such-id", false, 10)
	if err != nil {
		t.Fatalf("List(unknown cursor): %v", err)
	}
	if len(foreign) != 0 || len(unknown) != 0 {
		t.Errorf("foreign cursor returned %d rows, unknown cursor %d rows; want 0 and 0", len(foreign), len(unknown))
	}
	// Sanity: the caller's own cursor still pages.
	own, err := repo.List(ctx, dmBob, "bob-new", false, 10)
	if err != nil || len(own) != 1 || own[0].ID != "bob-old" {
		t.Errorf("own cursor page = %v (%v), want [bob-old]", notificationIDs(own), err)
	}
}

func TestNotificationRepo_DeleteByChannelID(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	repo := NewSQLiteNotificationRepo(db.Conn)
	ctx := context.Background()

	for _, ch := range []string{"ch-gone", "ch-gone", "ch-keep"} {
		c := ch
		if err := repo.Create(ctx, &models.Notification{UserID: dmBob, Kind: models.NotificationKindMention, ChannelID: &c}); err != nil {
			t.Fatalf("Create: %v", err)
		}
	}
	if err := repo.DeleteByChannelID(ctx, "ch-gone"); err != nil {
		t.Fatalf("DeleteByChannelID: %v", err)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM notifications WHERE channel_id = 'ch-gone'`); n != 0 {
		t.Errorf("%d notifications survived for the deleted channel", n)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM notifications WHERE channel_id = 'ch-keep'`); n != 1 {
		t.Errorf("notification for another channel was removed (got %d, want 1)", n)
	}
}

func TestNotificationRepo_MarkRequestRead(t *testing.T) {
	db := newTestDB(t)
	seedDMUsers(t, db)
	repo := NewSQLiteNotificationRepo(db.Conn)
	ctx := context.Background()

	alice, carol, dm := dmAlice, dmCarol, "dm-1"
	seed := []*models.Notification{
		{UserID: dmBob, Kind: models.NotificationKindFriendRequest, ActorID: &alice},   // target
		{UserID: dmBob, Kind: models.NotificationKindFriendRequest, ActorID: &carol},   // other sender, untouched
		{UserID: dmBob, Kind: models.NotificationKindMention, ActorID: &alice},         // other kind, untouched
		{UserID: dmAlice, Kind: models.NotificationKindFriendRequest, ActorID: &carol}, // other user, untouched
		{UserID: dmBob, Kind: models.NotificationKindDMRequest, ActorID: &alice, DMChannelID: &dm},
	}
	for _, n := range seed {
		if err := repo.Create(ctx, n); err != nil {
			t.Fatalf("Create: %v", err)
		}
	}

	ids, err := repo.MarkFriendRequestRead(ctx, dmBob, dmAlice)
	if err != nil {
		t.Fatalf("MarkFriendRequestRead: %v", err)
	}
	if len(ids) != 1 || ids[0] != seed[0].ID {
		t.Errorf("friend ids = %v, want [%s]", ids, seed[0].ID)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM notifications WHERE read_at IS NOT NULL`); n != 1 {
		t.Errorf("rows marked read = %d, want exactly 1", n)
	}
	// Idempotent: nothing left to mark, empty (non-nil) ids.
	again, err := repo.MarkFriendRequestRead(ctx, dmBob, dmAlice)
	if err != nil || again == nil || len(again) != 0 {
		t.Errorf("second MarkFriendRequestRead = (%v, %v), want ([], nil)", again, err)
	}

	ids, err = repo.MarkDMRequestRead(ctx, dmBob, dm)
	if err != nil {
		t.Fatalf("MarkDMRequestRead: %v", err)
	}
	if len(ids) != 1 || ids[0] != seed[4].ID {
		t.Errorf("dm ids = %v, want [%s]", ids, seed[4].ID)
	}
	if n, _ := repo.CountUnread(ctx, dmBob); n != 2 {
		t.Errorf("bob unread after settling = %d, want 2 (carol's request + the mention)", n)
	}
}
