// sqliteStickerRepo against a real local SQLite database (migration 087).
// Reuses sqlite_emoji_test.go's seedEmojiWorld (alice in A+B, bob in B,
// carol in C). DB harness: testdb_test.go.
package repository

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func newSticker(id, serverID, name string, animated bool, createdBy string) *models.ServerSticker {
	s := &models.ServerSticker{
		ID: id, ServerID: serverID, Name: name, DisplayName: name, Animated: animated,
		URL: "/api/uploads/stickers/" + id + ".png",
	}
	if animated {
		u := "/api/uploads/stickers/" + id + ".gif"
		s.AnimatedURL = &u
	}
	if createdBy != "" {
		s.CreatedBy = &createdBy
	}
	return s
}

func mustCreateSticker(t *testing.T, repo StickerRepository, s *models.ServerSticker) {
	t.Helper()
	if err := repo.CreateWithCap(context.Background(), s, models.MaxStickersPerServer); err != nil {
		t.Fatalf("CreateWithCap(%s): %v", s.ID, err)
	}
}

func TestStickerRepo_CRUD(t *testing.T) {
	db := newTestDB(t)
	seedEmojiWorld(t, db)
	repo := NewSQLiteStickerRepo(wrapForRepo(db))
	ctx := context.Background()

	s := newSticker("aaaaaaaaaaaaaaaa", emojiSrvA, "kedi", true, dmAlice)
	s.Copyable = true
	s.Description = "mutlu bir kedi"
	s.Tags = []string{"kedi", "Şeker"}
	mustCreateSticker(t, repo, s)
	assertRFC3339UTC(t, "CreateWithCap created_at", s.CreatedAt)

	got, err := repo.GetInServer(ctx, emojiSrvA, s.ID)
	if err != nil {
		t.Fatalf("GetInServer: %v", err)
	}
	if got.Name != "kedi" || !got.Animated || !got.Copyable || got.AnimatedURL == nil ||
		*got.AnimatedURL != *s.AnimatedURL || got.CreatedBy == nil || *got.CreatedBy != dmAlice ||
		got.Description != "mutlu bir kedi" || !slices.Equal(got.Tags, []string{"kedi", "Şeker"}) ||
		got.ClonedFrom != nil {
		t.Errorf("GetInServer = %+v", got)
	}
	assertRFC3339UTC(t, "GetInServer created_at", got.CreatedAt)
	storageQuery := `SELECT COUNT(*) FROM server_stickers WHERE created_at LIKE '____-__-__ __:__:__'`
	if database.IsPostgres(db.Conn) {
		storageQuery = `SELECT COUNT(*) FROM server_stickers WHERE created_at IS NOT NULL AND pg_typeof(created_at) = 'timestamptz'::regtype`
	}
	if n := countRows(t, db, storageQuery); n != 1 {
		t.Error("stored created_at is not 'YYYY-MM-DD HH:MM:SS' text")
	}

	if _, err := repo.GetInServer(ctx, emojiSrvB, s.ID); !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("GetInServer(other server) = %v, want ErrNotFound", err)
	}
	if _, err := repo.GetByID(ctx, "ffffffffffffffff"); !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("GetByID(missing) = %v, want ErrNotFound", err)
	}

	got.Name, got.DisplayName, got.Description, got.Tags, got.Copyable = "kedi2", "Kedi 2", "", []string{}, false
	if err := repo.Update(ctx, got); err != nil {
		t.Fatalf("Update: %v", err)
	}
	after, _ := repo.GetByID(ctx, s.ID)
	if after.Name != "kedi2" || after.DisplayName != "Kedi 2" || after.Copyable || after.Description != "" ||
		after.Tags == nil || len(after.Tags) != 0 {
		t.Errorf("after Update = %+v", after)
	}
	foreign := *after
	foreign.ServerID = emojiSrvB
	if err := repo.Update(ctx, &foreign); !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("Update(other server) = %v, want ErrNotFound", err)
	}

	if err := repo.Delete(ctx, emojiSrvB, s.ID); !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("Delete(other server) = %v, want ErrNotFound", err)
	}
	if err := repo.Delete(ctx, emojiSrvA, s.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if err := repo.Delete(ctx, emojiSrvA, s.ID); !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("Delete(again) = %v, want ErrNotFound", err)
	}
}

// TestStickerRepo_CapCountsBothTypes — with cap 1, a second sticker of
// EITHER type is refused by the conditional INSERT.
func TestStickerRepo_CapCountsBothTypes(t *testing.T) {
	db := newTestDB(t)
	seedEmojiWorld(t, db)
	repo := NewSQLiteStickerRepo(wrapForRepo(db))
	ctx := context.Background()

	if err := repo.CreateWithCap(ctx, newSticker("aaaaaaaaaaaaaaa1", emojiSrvA, "s1", false, dmAlice), 1); err != nil {
		t.Fatalf("first: %v", err)
	}
	if err := repo.CreateWithCap(ctx, newSticker("aaaaaaaaaaaaaaa2", emojiSrvA, "a1", true, dmAlice), 1); !errors.Is(err, models.ErrExpressionLimitReached) {
		t.Fatalf("second (animated): err = %v, want ErrExpressionLimitReached", err)
	}
	if err := repo.CreateWithCap(ctx, newSticker("aaaaaaaaaaaaaaa3", emojiSrvB, "s1", false, dmAlice), 1); err != nil {
		t.Fatalf("another server: %v", err)
	}
	if n, err := repo.CountByServer(ctx, emojiSrvA); err != nil || n != 1 {
		t.Errorf("CountByServer(A) = %d, %v — want 1", n, err)
	}
	if n, err := repo.CountByServer(ctx, emojiSrvC); err != nil || n != 0 {
		t.Errorf("CountByServer(empty) = %d, %v", n, err)
	}
}

func TestStickerRepo_UniqueNameIsAlreadyExists(t *testing.T) {
	db := newTestDB(t)
	seedEmojiWorld(t, db)
	repo := NewSQLiteStickerRepo(wrapForRepo(db))
	ctx := context.Background()

	mustCreateSticker(t, repo, newSticker("aaaaaaaaaaaaaaa1", emojiSrvA, "kedi", false, dmAlice))
	if err := repo.CreateWithCap(ctx, newSticker("aaaaaaaaaaaaaaa2", emojiSrvA, "kedi", false, dmAlice), 30); !errors.Is(err, pkg.ErrAlreadyExists) {
		t.Errorf("duplicate name: err = %v, want ErrAlreadyExists", err)
	}
	mustCreateSticker(t, repo, newSticker("aaaaaaaaaaaaaaa3", emojiSrvB, "kedi", false, dmAlice)) // other server: fine
	mustCreateSticker(t, repo, newSticker("aaaaaaaaaaaaaaa4", emojiSrvA, "kopek", false, dmAlice))
	s, _ := repo.GetByID(ctx, "aaaaaaaaaaaaaaa4")
	s.Name = "kedi"
	if err := repo.Update(ctx, s); !errors.Is(err, pkg.ErrAlreadyExists) {
		t.Errorf("rename onto taken name: err = %v, want ErrAlreadyExists", err)
	}
}

func TestStickerRepo_ListForUserOnlyMemberServers(t *testing.T) {
	db := newTestDB(t)
	seedEmojiWorld(t, db)
	repo := NewSQLiteStickerRepo(wrapForRepo(db))
	ctx := context.Background()

	mustCreateSticker(t, repo, newSticker("aaaaaaaaaaaaaaa1", emojiSrvA, "zeta", false, dmAlice))
	mustCreateSticker(t, repo, newSticker("aaaaaaaaaaaaaaa2", emojiSrvA, "alfa", false, dmAlice))
	mustCreateSticker(t, repo, newSticker("aaaaaaaaaaaaaaa3", emojiSrvB, "beta", false, dmAlice))
	mustCreateSticker(t, repo, newSticker("aaaaaaaaaaaaaaa4", emojiSrvC, "gizli", false, dmCarol))

	bob, err := repo.ListForUser(ctx, dmBob)
	if err != nil || len(bob) != 1 || bob[0].ServerID != emojiSrvB {
		t.Errorf("ListForUser(bob) = %+v, %v — want only server B", bob, err)
	}
	alice, _ := repo.ListForUser(ctx, dmAlice)
	if len(alice) != 3 {
		t.Fatalf("ListForUser(alice) = %d rows, want 3", len(alice))
	}
	for _, s := range alice {
		if s.ServerID == emojiSrvC {
			t.Error("ListForUser leaked a non-member server's sticker")
		}
		if s.Tags == nil {
			t.Error("Tags is nil, want []")
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

func TestStickerRepo_ClonedFromAndTagsRoundTrip(t *testing.T) {
	db := newTestDB(t)
	seedEmojiWorld(t, db)
	repo := NewSQLiteStickerRepo(wrapForRepo(db))
	ctx := context.Background()

	src := "bbbbbbbbbbbbbbbb"
	s := newSticker("aaaaaaaaaaaaaaa1", emojiSrvA, "kopya", false, dmAlice)
	s.ClonedFrom = &src
	s.Tags = nil // nil is stored as '[]'
	mustCreateSticker(t, repo, s)
	if n := countRows(t, db, `SELECT COUNT(*) FROM server_stickers WHERE id = ? AND tags = '[]'`, s.ID); n != 1 {
		t.Error("nil tags not stored as '[]'")
	}
	got, err := repo.GetByID(ctx, s.ID)
	if err != nil || got.ClonedFrom == nil || *got.ClonedFrom != src || got.Tags == nil || len(got.Tags) != 0 {
		t.Errorf("GetByID = %+v, %v", got, err)
	}

	// A corrupt tags value reads back as no tags rather than an error.
	if _, err := db.Conn.Exec(`UPDATE server_stickers SET tags = 'not json' WHERE id = ?`, s.ID); err != nil {
		t.Fatalf("corrupt tags: %v", err)
	}
	got, err = repo.GetByID(ctx, s.ID)
	if err != nil || got.Tags == nil || len(got.Tags) != 0 {
		t.Errorf("corrupt tags: %+v, %v — want [] and no error", got, err)
	}
}
