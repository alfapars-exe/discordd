package repository

import (
	"context"
	"testing"

	"github.com/argeinfina/hichat/models"
)

// TestHardDeleteUser_RemovesCosmeticRows - deleting bob removes his slots,
// plain switches and the grants he received; the grant he made to alice
// survives with granted_by NULL and the server item he created survives
// with created_by NULL. Alice's rows are untouched.
func TestHardDeleteUser_RemovesCosmeticRows(t *testing.T) {
	db := newTestDB(t)
	seedCosmeticWorld(t, db) // bob created cosItemGrantedA
	grantCosmetic(t, db, dmAlice, cosItemGrantedA, emojiSrvA, dmBob)
	grantCosmetic(t, db, dmBob, cosItemGrantedA, emojiSrvA, dmAlice)
	cosmetics := NewSQLiteCosmeticRepo(wrapForRepo(db))
	users := NewSQLiteUserRepo(db.Conn)
	ctx := context.Background()

	aurora := builtinRow(t, cosmetics, "b_frame_aurora")
	for _, u := range []string{dmAlice, dmBob} {
		mustApplyEquip(t, cosmetics, u, "", map[string]models.CosmeticEquipRow{models.CosmeticTypeAvatarFrame: aurora}, nil)
		mustApplyEquip(t, cosmetics, u, emojiSrvB, map[string]models.CosmeticEquipRow{models.CosmeticTypeAvatarFrame: aurora}, nil)
		if _, err := cosmetics.SetPlainServer(ctx, u, emojiSrvB, true); err != nil {
			t.Fatalf("SetPlainServer: %v", err)
		}
	}

	if err := users.HardDeleteUser(ctx, dmBob, dmCarol); err != nil {
		t.Fatalf("HardDeleteUser: %v", err)
	}

	for q, want := range map[string]int{
		`SELECT COUNT(*) FROM user_equipped WHERE user_id = 'u-bob'`:                                   0,
		`SELECT COUNT(*) FROM user_cosmetic_plain_servers WHERE user_id = 'u-bob'`:                     0,
		`SELECT COUNT(*) FROM user_cosmetics WHERE user_id = 'u-bob'`:                                  0,
		`SELECT COUNT(*) FROM user_equipped WHERE user_id = 'u-alice'`:                                 2,
		`SELECT COUNT(*) FROM user_cosmetic_plain_servers WHERE user_id = 'u-alice'`:                   1,
		`SELECT COUNT(*) FROM user_cosmetics WHERE user_id = 'u-alice' AND granted_by IS NULL`:         1,
		`SELECT COUNT(*) FROM cosmetic_items WHERE id = 'aaaaaaaaaaaa0002' AND created_by IS NULL`:     1,
		`SELECT COUNT(*) FROM cosmetic_items WHERE id = 'aaaaaaaaaaaa0001' AND created_by = 'u-alice'`: 1,
	} {
		if n := countRows(t, db, q); n != want {
			t.Errorf("%s = %d after hard delete, want %d", q, n, want)
		}
	}
}
