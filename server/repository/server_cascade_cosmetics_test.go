package repository

import (
	"context"
	"testing"

	"github.com/argeinfina/hichat/models"
)

// TestDeleteServerCascade_RemovesCosmeticRows runs the cascade over a
// connection with foreign_keys OFF (the Turso condition): server A's items,
// grants, plain switches, A-scoped slots and slots anywhere wearing an A
// item go; server B's rows, the built-in catalog and alice's global
// built-in slot survive.
func TestDeleteServerCascade_RemovesCosmeticRows(t *testing.T) {
	db, path := newTestDBWithPath(t)
	seedCosmeticWorld(t, db)
	grantCosmetic(t, db, dmAlice, cosItemGrantedA, emojiSrvA, dmBob)
	repo := NewSQLiteCosmeticRepo(wrapForRepo(db))
	ctx := context.Background()

	aurora := builtinRow(t, repo, "b_frame_aurora")
	freeA := models.CosmeticEquipRow{ItemID: cosItemFreeA, Format: "css", AssetSnapshot: cosPlateAsset}
	mustApplyEquip(t, repo, dmAlice, "", map[string]models.CosmeticEquipRow{models.CosmeticTypeAvatarFrame: aurora}, nil)
	mustApplyEquip(t, repo, dmAlice, emojiSrvA, map[string]models.CosmeticEquipRow{
		models.CosmeticTypeAvatarFrame: aurora, models.CosmeticTypeNameplate: freeA}, nil)
	mustApplyEquip(t, repo, dmAlice, emojiSrvB, map[string]models.CosmeticEquipRow{models.CosmeticTypeAvatarFrame: aurora}, nil)
	// A slot outside A that wears an A item (only reachable with FKs off /
	// a stale row): it must go with the item.
	execWithoutFKs(t, path, `INSERT INTO user_equipped (user_id, scope_server_id, type, item_id, format, asset_snapshot)
		VALUES ('u-bob', 'emoji-srv-b', 'nameplate', 'aaaaaaaaaaaa0001', 'css', '`+cosPlateAsset+`')`)
	for _, srv := range []string{emojiSrvA, emojiSrvB} {
		if _, err := repo.SetPlainServer(ctx, dmAlice, srv, true); err != nil {
			t.Fatalf("SetPlainServer: %v", err)
		}
	}

	if err := deleteServerCascade(ctx, entranceFKOffConn(t, path), emojiSrvA); err != nil {
		t.Fatalf("deleteServerCascade: %v", err)
	}

	for q, want := range map[string]int{
		`SELECT COUNT(*) FROM cosmetic_items WHERE server_id = 'emoji-srv-a'`:                              0,
		`SELECT COUNT(*) FROM user_cosmetics WHERE server_id = 'emoji-srv-a'`:                              0,
		`SELECT COUNT(*) FROM user_cosmetic_plain_servers WHERE server_id = 'emoji-srv-a'`:                 0,
		`SELECT COUNT(*) FROM user_equipped WHERE scope_server_id = 'emoji-srv-a'`:                         0,
		`SELECT COUNT(*) FROM user_equipped WHERE item_id = 'aaaaaaaaaaaa0001'`:                            0,
		`SELECT COUNT(*) FROM cosmetic_items WHERE server_id IS NULL`:                                      30,
		`SELECT COUNT(*) FROM cosmetic_items WHERE server_id = 'emoji-srv-c'`:                              1,
		`SELECT COUNT(*) FROM user_cosmetic_plain_servers WHERE server_id = 'emoji-srv-b'`:                 1,
		`SELECT COUNT(*) FROM user_equipped WHERE user_id = 'u-alice' AND scope_server_id = ''`:            1,
		`SELECT COUNT(*) FROM user_equipped WHERE user_id = 'u-alice' AND scope_server_id = 'emoji-srv-b'`: 1,
	} {
		if n := countRows(t, db, q); n != want {
			t.Errorf("%s = %d after cascade, want %d", q, n, want)
		}
	}
}
