// sqliteSearchRepo against a real local SQLite database.
//
// H-05: SearchService now passes an RBAC-derived allowedChannelIDs filter
// into Search. These tests exercise the actual SQL (buildSearchFilter +
// the count/data queries), not a mock, because the bug class here is
// exactly "count query and data query silently disagree" — something a
// mocked repository can't catch.
//
// DB harness / fixtures: testdb_test.go, sqlite_message_test.go
// (seedMessageWorld, newMessage, msgChannel, msgOtherChannel, msgAuthor).
package repository

import (
	"context"
	"testing"
)

func TestSearchRepo_AllowedChannelIDs_FiltersCountAndData(t *testing.T) {
	db := newTestDB(t)
	seedMessageWorld(t, db)
	msgRepo := NewSQLiteMessageRepo(db.Conn)
	search := NewSQLiteSearchRepo(db.Conn)
	ctx := context.Background()

	newMessage(t, ctx, msgRepo, msgChannel, msgAuthor, "gizlenmis anahtar kelime")
	newMessage(t, ctx, msgRepo, msgOtherChannel, msgAuthor, "gizlenmis anahtar kelime")

	// Unrestricted (nil allow-list): both channels' hits count — baseline
	// showing the fixture actually has two matching messages.
	all, err := search.Search(ctx, "gizlenmis", "srv-1", nil, nil, 25, 0)
	if err != nil {
		t.Fatalf("unrestricted search: %v", err)
	}
	if all.TotalCount != 2 {
		t.Fatalf("unrestricted TotalCount = %d, want 2", all.TotalCount)
	}

	// H-05: an allow-list limited to msgChannel must filter both the page
	// AND the total count — a count/page mismatch would itself leak how
	// many messages exist in the excluded channel.
	filtered, err := search.Search(ctx, "gizlenmis", "srv-1", nil, []string{msgChannel}, 25, 0)
	if err != nil {
		t.Fatalf("filtered search: %v", err)
	}
	if filtered.TotalCount != 1 {
		t.Fatalf("filtered TotalCount = %d, want 1", filtered.TotalCount)
	}
	if len(filtered.Messages) != 1 || filtered.Messages[0].ChannelID != msgChannel {
		t.Fatalf("filtered messages = %+v, want exactly one hit in %s", filtered.Messages, msgChannel)
	}

	// An explicit channel_id outside the allow-list must intersect to
	// nothing, not fall back to the explicit filter alone (N-03/H-05 plan:
	// "the explicit channel filter is intersected with the permission set").
	other := msgOtherChannel
	intersected, err := search.Search(ctx, "gizlenmis", "srv-1", &other, []string{msgChannel}, 25, 0)
	if err != nil {
		t.Fatalf("intersected search: %v", err)
	}
	if intersected.TotalCount != 0 || len(intersected.Messages) != 0 {
		t.Fatalf("expected the channel_id/allow-list intersection to be empty, got %+v", intersected)
	}
}

func TestSearchRepo_EmptyAllowedChannelIDs_ReturnsEmptyWithoutQuerying(t *testing.T) {
	db := newTestDB(t)
	seedMessageWorld(t, db)
	msgRepo := NewSQLiteMessageRepo(db.Conn)
	search := NewSQLiteSearchRepo(db.Conn)
	ctx := context.Background()

	newMessage(t, ctx, msgRepo, msgChannel, msgAuthor, "herhangi bir metin")

	// A non-nil-but-empty allow-list means the caller may read zero
	// channels: defensive short circuit in the repository itself, mirroring
	// SearchService's own empty-list guard.
	res, err := search.Search(ctx, "herhangi", "srv-1", nil, []string{}, 25, 0)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if res.TotalCount != 0 || len(res.Messages) != 0 {
		t.Fatalf("expected empty result for an empty (non-nil) allow-list, got %+v", res)
	}
}
