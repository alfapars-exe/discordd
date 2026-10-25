package repository

import (
	"context"
	"reflect"
	"testing"

	"github.com/argeinfina/hichat/models"
)

func TestGroupDMHistoryPaginationTimestampTies(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	if _, err := db.Conn.Exec(`INSERT INTO users(id,username,password_hash) VALUES('history-sender','history-sender','x')`); err != nil {
		t.Fatal(err)
	}
	repo := NewSQLiteGroupDMRepo(wrapForRepo(db))
	for _, id := range []string{"history-group", "foreign-history"} {
		if err := repo.Create(ctx, &models.GroupDM{ID: id, OwnerID: "history-sender", Name: id, KeyEpoch: 1, CallRoomKey: "room-" + id}, []string{"history-sender"}); err != nil {
			t.Fatal(err)
		}
	}
	for _, id := range []string{"m1", "m2", "m3", "m4", "m5", "foreign"} {
		group := "history-group"
		if id == "foreign" {
			group = "foreign-history"
		}
		if err := repo.CreateMessage(ctx, &models.GroupDMMessage{ID: id, GroupID: group, UserID: "history-sender", KeyEpoch: 1}); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Conn.Exec(`UPDATE group_dm_messages SET created_at=? WHERE id=?`, "2026-01-01 10:00:00", id); err != nil {
			t.Fatal(err)
		}
	}
	before := ""
	var got []string
	for page := 0; page < 4; page++ {
		items, err := repo.ListMessages(ctx, "history-group", before, 2)
		if err != nil {
			t.Fatal(err)
		}
		if len(items) == 0 {
			break
		}
		for _, item := range items {
			got = append(got, item.ID)
		}
		before = items[len(items)-1].ID
	}
	if !reflect.DeepEqual(got, []string{"m5", "m4", "m3", "m2", "m1"}) {
		t.Fatalf("history skipped or repeated tied rows: %v", got)
	}
	for _, anchor := range []string{"foreign", "missing"} {
		items, err := repo.ListMessages(ctx, "history-group", anchor, 2)
		if err != nil || len(items) != 0 {
			t.Fatalf("anchor %q: items=%v err=%v", anchor, items, err)
		}
	}
}
