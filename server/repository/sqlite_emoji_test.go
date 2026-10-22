// sqliteEmojiRepo against a real local SQLite database (migration 086).
// DB harness: testdb_test.go.
package repository

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

const (
	emojiSrvA = "emoji-srv-a"
	emojiSrvB = "emoji-srv-b"
	emojiSrvC = "emoji-srv-c"
)

// seedEmojiWorld: alice, bob, carol; servers A and B owned by alice, C by
// carol. alice is a member of A and B, bob of B only, carol of C.
func seedEmojiWorld(t *testing.T, db *database.DB) {
	t.Helper()
	seedDMUsers(t, db)
	execSeed(t, db, []seedStmt{
		{`INSERT INTO servers (id, name, owner_id) VALUES (?, 'A', ?)`, []any{emojiSrvA, dmAlice}},
		{`INSERT INTO servers (id, name, owner_id) VALUES (?, 'B', ?)`, []any{emojiSrvB, dmAlice}},
		{`INSERT INTO servers (id, name, owner_id) VALUES (?, 'C', ?)`, []any{emojiSrvC, dmCarol}},
		{`INSERT INTO server_members (server_id, user_id) VALUES (?, ?)`, []any{emojiSrvA, dmAlice}},
		{`INSERT INTO server_members (server_id, user_id) VALUES (?, ?)`, []any{emojiSrvB, dmAlice}},
		{`INSERT INTO server_members (server_id, user_id) VALUES (?, ?)`, []any{emojiSrvB, dmBob}},
		{`INSERT INTO server_members (server_id, user_id) VALUES (?, ?)`, []any{emojiSrvC, dmCarol}},
	})
}

func newEmoji(id, serverID, name string, animated bool, createdBy string) *models.ServerEmoji {
	e := &models.ServerEmoji{
		ID: id, ServerID: serverID, Name: name, DisplayName: name, Animated: animated,
		URL: "/api/uploads/emojis/" + id + ".png",
	}
	if animated {
		u := "/api/uploads/emojis/" + id + ".gif"
		e.AnimatedURL = &u
	}
	if createdBy != "" {
		e.CreatedBy = &createdBy
	}
	return e
}

func mustCreateEmoji(t *testing.T, repo EmojiRepository, e *models.ServerEmoji) {
	t.Helper()
	if err := repo.CreateWithCap(context.Background(), e, 100); err != nil {
		t.Fatalf("CreateWithCap(%s): %v", e.ID, err)
	}
}

func TestEmojiRepo_CRUD(t *testing.T) {
	db := newTestDB(t)
	seedEmojiWorld(t, db)
	repo := NewSQLiteEmojiRepo(wrapForRepo(db))
	ctx := context.Background()

	e := newEmoji("aaaaaaaaaaaaaaaa", emojiSrvA, "kedi", true, dmAlice)
	e.Copyable = true
	mustCreateEmoji(t, repo, e)
	assertRFC3339UTC(t, "CreateWithCap created_at", e.CreatedAt)

	got, err := repo.GetInServer(ctx, emojiSrvA, e.ID)
	if err != nil {
		t.Fatalf("GetInServer: %v", err)
	}
	if got.Name != "kedi" || !got.Animated || !got.Copyable || got.AnimatedURL == nil ||
		*got.AnimatedURL != *e.AnimatedURL || got.CreatedBy == nil || *got.CreatedBy != dmAlice {
		t.Errorf("GetInServer = %+v", got)
	}
	assertRFC3339UTC(t, "GetInServer created_at", got.CreatedAt)
	if n := countRows(t, db, `SELECT COUNT(*) FROM server_emojis WHERE created_at LIKE '____-__-__ __:__:__'`); n != 1 {
		t.Error("stored created_at is not 'YYYY-MM-DD HH:MM:SS' text")
	}

	if _, err := repo.GetInServer(ctx, emojiSrvB, e.ID); !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("GetInServer(other server) = %v, want ErrNotFound", err)
	}
	if _, err := repo.GetByID(ctx, "ffffffffffffffff"); !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("GetByID(missing) = %v, want ErrNotFound", err)
	}

	got.Name, got.DisplayName, got.Copyable = "kedi2", "Kedi 2", false
	if err := repo.Update(ctx, got); err != nil {
		t.Fatalf("Update: %v", err)
	}
	after, _ := repo.GetByID(ctx, e.ID)
	if after.Name != "kedi2" || after.DisplayName != "Kedi 2" || after.Copyable {
		t.Errorf("after Update = %+v", after)
	}
	foreign := *after
	foreign.ServerID = emojiSrvB
	if err := repo.Update(ctx, &foreign); !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("Update(other server) = %v, want ErrNotFound", err)
	}

	if err := repo.Delete(ctx, emojiSrvB, e.ID); !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("Delete(other server) = %v, want ErrNotFound", err)
	}
	if err := repo.Delete(ctx, emojiSrvA, e.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if err := repo.Delete(ctx, emojiSrvA, e.ID); !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("Delete(again) = %v, want ErrNotFound", err)
	}
}

// TestEmojiRepo_CapIsPerType — with cap 1, a second emoji of the same type
// is refused by the conditional INSERT, while the other type still fits.
func TestEmojiRepo_CapIsPerType(t *testing.T) {
	db := newTestDB(t)
	seedEmojiWorld(t, db)
	repo := NewSQLiteEmojiRepo(wrapForRepo(db))
	ctx := context.Background()

	if err := repo.CreateWithCap(ctx, newEmoji("aaaaaaaaaaaaaaa1", emojiSrvA, "s1", false, dmAlice), 1); err != nil {
		t.Fatalf("first static: %v", err)
	}
	if err := repo.CreateWithCap(ctx, newEmoji("aaaaaaaaaaaaaaa2", emojiSrvA, "s2", false, dmAlice), 1); !errors.Is(err, models.ErrExpressionLimitReached) {
		t.Fatalf("second static: err = %v, want ErrExpressionLimitReached", err)
	}
	if err := repo.CreateWithCap(ctx, newEmoji("aaaaaaaaaaaaaaa3", emojiSrvA, "a1", true, dmAlice), 1); err != nil {
		t.Fatalf("first animated: %v", err)
	}
	if err := repo.CreateWithCap(ctx, newEmoji("aaaaaaaaaaaaaaa4", emojiSrvB, "s1", false, dmAlice), 1); err != nil {
		t.Fatalf("static in another server: %v", err)
	}
	static, animated, err := repo.CountByServer(ctx, emojiSrvA)
	if err != nil || static != 1 || animated != 1 {
		t.Errorf("CountByServer = (%d, %d, %v), want (1, 1)", static, animated, err)
	}
	if s, a, err := repo.CountByServer(ctx, emojiSrvC); err != nil || s != 0 || a != 0 {
		t.Errorf("CountByServer(empty) = (%d, %d, %v)", s, a, err)
	}
}

func TestEmojiRepo_UniqueNameIsAlreadyExists(t *testing.T) {
	db := newTestDB(t)
	seedEmojiWorld(t, db)
	repo := NewSQLiteEmojiRepo(wrapForRepo(db))
	ctx := context.Background()

	mustCreateEmoji(t, repo, newEmoji("aaaaaaaaaaaaaaa1", emojiSrvA, "kedi", false, dmAlice))
	if err := repo.CreateWithCap(ctx, newEmoji("aaaaaaaaaaaaaaa2", emojiSrvA, "kedi", false, dmAlice), 100); !errors.Is(err, pkg.ErrAlreadyExists) {
		t.Errorf("duplicate name: err = %v, want ErrAlreadyExists", err)
	}
	mustCreateEmoji(t, repo, newEmoji("aaaaaaaaaaaaaaa3", emojiSrvB, "kedi", false, dmAlice)) // other server: fine

	mustCreateEmoji(t, repo, newEmoji("aaaaaaaaaaaaaaa4", emojiSrvA, "kopek", false, dmAlice))
	e, _ := repo.GetByID(ctx, "aaaaaaaaaaaaaaa4")
	e.Name = "kedi"
	if err := repo.Update(ctx, e); !errors.Is(err, pkg.ErrAlreadyExists) {
		t.Errorf("rename onto taken name: err = %v, want ErrAlreadyExists", err)
	}
}

func TestEmojiRepo_ListForUserOnlyMemberServers(t *testing.T) {
	db := newTestDB(t)
	seedEmojiWorld(t, db)
	repo := NewSQLiteEmojiRepo(wrapForRepo(db))
	ctx := context.Background()

	mustCreateEmoji(t, repo, newEmoji("aaaaaaaaaaaaaaa1", emojiSrvA, "zeta", false, dmAlice))
	mustCreateEmoji(t, repo, newEmoji("aaaaaaaaaaaaaaa2", emojiSrvA, "alfa", false, dmAlice))
	mustCreateEmoji(t, repo, newEmoji("aaaaaaaaaaaaaaa3", emojiSrvB, "beta", false, dmAlice))
	mustCreateEmoji(t, repo, newEmoji("aaaaaaaaaaaaaaa4", emojiSrvC, "gizli", false, dmCarol))

	bob, err := repo.ListForUser(ctx, dmBob)
	if err != nil || len(bob) != 1 || bob[0].ServerID != emojiSrvB {
		t.Errorf("ListForUser(bob) = %+v, %v — want only server B", bob, err)
	}
	alice, _ := repo.ListForUser(ctx, dmAlice)
	if len(alice) != 3 {
		t.Fatalf("ListForUser(alice) = %d rows, want 3", len(alice))
	}
	for _, e := range alice {
		if e.ServerID == emojiSrvC {
			t.Error("ListForUser leaked a non-member server's emoji")
		}
	}
	byServer, _ := repo.ListByServer(ctx, emojiSrvA)
	if len(byServer) != 2 || byServer[0].Name != "alfa" || byServer[1].Name != "zeta" {
		t.Errorf("ListByServer(A) = %+v, want [alfa zeta]", byServer)
	}

	none, err := repo.ListForUser(ctx, "nobody")
	if err != nil || none == nil || len(none) != 0 {
		t.Errorf("ListForUser(nobody) = %#v, %v — want non-nil empty slice", none, err)
	}
	empty, err := repo.ListByServer(ctx, "no-such-server")
	if err != nil || empty == nil || len(empty) != 0 {
		t.Errorf("ListByServer(empty) = %#v, %v — want non-nil empty slice", empty, err)
	}
}

// TestEmojiRepo_ClonedFromRoundTrip — cloned_from (D2) is written by
// CreateWithCap and read back by every SELECT through scanEmojiRow.
func TestEmojiRepo_ClonedFromRoundTrip(t *testing.T) {
	db := newTestDB(t)
	seedEmojiWorld(t, db)
	repo := NewSQLiteEmojiRepo(wrapForRepo(db))
	ctx := context.Background()

	src := "bbbbbbbbbbbbbbbb"
	clone := newEmoji("aaaaaaaaaaaaaaa1", emojiSrvA, "kopya", false, dmAlice)
	clone.ClonedFrom = &src
	mustCreateEmoji(t, repo, clone)
	mustCreateEmoji(t, repo, newEmoji("aaaaaaaaaaaaaaa2", emojiSrvA, "asil", false, dmAlice))

	byID, err := repo.GetByID(ctx, clone.ID)
	if err != nil || byID.ClonedFrom == nil || *byID.ClonedFrom != src {
		t.Errorf("GetByID cloned_from = %v, %v", byID, err)
	}
	inServer, _ := repo.GetInServer(ctx, emojiSrvA, clone.ID)
	if inServer == nil || inServer.ClonedFrom == nil || *inServer.ClonedFrom != src {
		t.Errorf("GetInServer cloned_from = %+v", inServer)
	}
	list, _ := repo.ListByServer(ctx, emojiSrvA)
	mine, _ := repo.ListForUser(ctx, dmAlice)
	for name, rows := range map[string][]models.ServerEmoji{"ListByServer": list, "ListForUser": mine} {
		if len(rows) != 2 {
			t.Fatalf("%s = %d rows, want 2", name, len(rows))
		}
		for _, e := range rows {
			if e.ID == clone.ID {
				if e.ClonedFrom == nil || *e.ClonedFrom != src {
					t.Errorf("%s clone cloned_from = %v", name, e.ClonedFrom)
				}
			} else if e.ClonedFrom != nil {
				t.Errorf("%s original cloned_from = %q, want nil", name, *e.ClonedFrom)
			}
		}
	}
}
