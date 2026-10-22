package repository

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

// Server items used by the cosmetics tests: a free and a granted nameplate
// on server A, a free nameplate on server C (alice is not a member of C).
const (
	cosItemFreeA    = "aaaaaaaaaaaa0001"
	cosItemGrantedA = "aaaaaaaaaaaa0002"
	cosItemFreeC    = "cccccccccccc0001"
	cosPlateAsset   = `{"v":1,"stops":["#000000","#111111"],"angle":0,"pattern":"none"}`
)

// seedCosmeticWorld = seedEmojiWorld (alice/bob/carol, servers A/B/C,
// alice in A+B, bob in B, carol in C) plus three server items and a grant
// of the granted item to alice by carol.
func seedCosmeticWorld(t *testing.T, db *database.DB) {
	t.Helper()
	seedEmojiWorld(t, db)
	execSeed(t, db, []seedStmt{
		{`INSERT INTO cosmetic_items (id, server_id, type, format, name, asset_json, availability, created_by)
			VALUES (?, ?, 'nameplate', 'css', 'Free A', ?, 'free', ?)`, []any{cosItemFreeA, emojiSrvA, cosPlateAsset, dmAlice}},
		{`INSERT INTO cosmetic_items (id, server_id, type, format, name, asset_json, availability, created_by)
			VALUES (?, ?, 'nameplate', 'css', 'Granted A', ?, 'granted', ?)`, []any{cosItemGrantedA, emojiSrvA, cosPlateAsset, dmBob}},
		{`INSERT INTO cosmetic_items (id, server_id, type, format, name, asset_json, availability)
			VALUES (?, ?, 'nameplate', 'css', 'Free C', ?, 'free')`, []any{cosItemFreeC, emojiSrvC, cosPlateAsset}},
	})
}

func grantCosmetic(t *testing.T, db *database.DB, userID, itemID, serverID, grantedBy string) {
	t.Helper()
	execSeed(t, db, []seedStmt{
		{`INSERT INTO user_cosmetics (user_id, item_id, server_id, granted_by, reason) VALUES (?, ?, ?, ?, 'test')`,
			[]any{userID, itemID, serverID, grantedBy}},
	})
}

// builtinRow builds the equip row of a built-in item the way the service
// does (canonical snapshot).
func builtinRow(t *testing.T, repo CosmeticRepository, id string) models.CosmeticEquipRow {
	t.Helper()
	it, err := repo.GetItem(context.Background(), id)
	if err != nil {
		t.Fatalf("GetItem(%s): %v", id, err)
	}
	asset, err := it.CanonicalAsset()
	if err != nil {
		t.Fatalf("CanonicalAsset(%s): %v", id, err)
	}
	return models.CosmeticEquipRow{ItemID: it.ID, Format: it.Format, Animated: it.Animated, AssetSnapshot: string(asset)}
}

func mustApplyEquip(t *testing.T, repo CosmeticRepository, userID, scope string, set map[string]models.CosmeticEquipRow, unset []string) bool {
	t.Helper()
	changed, err := repo.ApplyEquip(context.Background(), userID, scope, set, unset)
	if err != nil {
		t.Fatalf("ApplyEquip(%s, %q): %v", userID, scope, err)
	}
	return changed
}

func TestCosmeticRepo_CatalogAndGrants(t *testing.T) {
	db := newTestDB(t)
	seedCosmeticWorld(t, db)
	grantCosmetic(t, db, dmAlice, cosItemGrantedA, emojiSrvA, dmCarol)
	repo := NewSQLiteCosmeticRepo(wrapForRepo(db))
	ctx := context.Background()

	builtins, err := repo.ListBuiltinItems(ctx)
	if err != nil {
		t.Fatalf("ListBuiltinItems: %v", err)
	}
	if len(builtins) != 30 || builtins[0].ID != "b_frame_aurora" || builtins[29].ID != "b_effect_stars" {
		t.Fatalf("ListBuiltinItems = %d items (first %s), want 30 in type/sort order", len(builtins), builtins[0].ID)
	}
	for _, it := range builtins {
		if it.ServerID != nil || it.Availability != models.CosmeticAvailabilityFree {
			t.Errorf("built-in %s: server_id %v availability %s", it.ID, it.ServerID, it.Availability)
		}
		assertRFC3339UTC(t, "built-in created_at", it.CreatedAt)
	}

	// alice: member of A (free + granted) and B; C is not hers.
	mine, err := repo.ListEquippableServerItems(ctx, dmAlice)
	if err != nil {
		t.Fatalf("ListEquippableServerItems(alice): %v", err)
	}
	if len(mine) != 2 || mine[0].ID != cosItemFreeA || mine[1].ID != cosItemGrantedA {
		t.Errorf("alice's equippable server items = %+v, want free A + granted A", mine)
	}
	// bob: member of B only - nothing.
	if bobs, _ := repo.ListEquippableServerItems(ctx, dmBob); len(bobs) != 0 {
		t.Errorf("bob's equippable server items = %+v, want none", bobs)
	}

	it, err := repo.GetItem(ctx, cosItemGrantedA)
	if err != nil {
		t.Fatalf("GetItem: %v", err)
	}
	if it.ServerID == nil || *it.ServerID != emojiSrvA || it.CreatedBy == nil || *it.CreatedBy != dmBob || it.AssetJSON == nil {
		t.Errorf("GetItem = %+v", it)
	}
	if _, err := repo.GetItem(ctx, "missing"); !errors.Is(err, models.ErrCosmeticItemNotFound) {
		t.Errorf("GetItem(missing): err = %v, want ErrCosmeticItemNotFound", err)
	}
	if err := models.ErrCosmeticItemNotFound; err.Error() != "not found: cosmetic item not found" {
		t.Errorf("repo not-found text = %q, want its own wording (trap #248)", err.Error())
	}

	if ok, _ := repo.HasGrant(ctx, dmAlice, cosItemGrantedA); !ok {
		t.Error("HasGrant(alice, granted A) = false")
	}
	if ok, _ := repo.HasGrant(ctx, dmBob, cosItemGrantedA); ok {
		t.Error("HasGrant(bob, granted A) = true")
	}
	grants, err := repo.ListGrants(ctx, dmAlice)
	if err != nil {
		t.Fatalf("ListGrants: %v", err)
	}
	if len(grants) != 1 || grants[0].ItemID != cosItemGrantedA || grants[0].ServerID != emojiSrvA ||
		grants[0].GrantedBy == nil || grants[0].GrantedBy.ID != dmCarol || grants[0].GrantedBy.Username != "carol" {
		t.Fatalf("ListGrants = %+v", grants)
	}
	assertRFC3339UTC(t, "granted_at", grants[0].GrantedAt)
	if none, _ := repo.ListGrants(ctx, dmBob); none == nil || len(none) != 0 {
		t.Errorf("ListGrants(bob) = %#v, want empty non-nil", none)
	}
}

func TestCosmeticRepo_ApplyEquipUpsertUnsetNoop(t *testing.T) {
	db := newTestDB(t)
	seedCosmeticWorld(t, db)
	repo := NewSQLiteCosmeticRepo(wrapForRepo(db))
	ctx := context.Background()

	frame := builtinRow(t, repo, "b_frame_aurora")
	plate := builtinRow(t, repo, "b_plate_dusk")
	if !mustApplyEquip(t, repo, dmAlice, "", map[string]models.CosmeticEquipRow{
		models.CosmeticTypeAvatarFrame: frame, models.CosmeticTypeNameplate: plate}, nil) {
		t.Error("first equip: changed = false")
	}
	// Same request again: nothing to write.
	if mustApplyEquip(t, repo, dmAlice, "", map[string]models.CosmeticEquipRow{
		models.CosmeticTypeAvatarFrame: frame, models.CosmeticTypeNameplate: plate}, nil) {
		t.Error("identical equip: changed = true, want false")
	}
	// Unsetting an empty slot is a no-op too.
	if mustApplyEquip(t, repo, dmAlice, "", nil, []string{models.CosmeticTypeProfileEffect}) {
		t.Error("unset of an empty slot: changed = true, want false")
	}
	// Replace the frame and clear the plate in one call.
	ember := builtinRow(t, repo, "b_frame_ember")
	if !mustApplyEquip(t, repo, dmAlice, "", map[string]models.CosmeticEquipRow{models.CosmeticTypeAvatarFrame: ember},
		[]string{models.CosmeticTypeNameplate}) {
		t.Error("replace + unset: changed = false")
	}
	rows, err := repo.ListEquipped(ctx, dmAlice)
	if err != nil {
		t.Fatalf("ListEquipped: %v", err)
	}
	if len(rows) != 1 || rows[0].ItemID != "b_frame_ember" || rows[0].ScopeServerID != "" || !rows[0].Animated ||
		rows[0].AssetSnapshot != `{"v":1,"frame":"ember"}` || rows[0].ItemServerID != nil {
		t.Fatalf("ListEquipped = %+v", rows)
	}
	assertRFC3339UTC(t, "equipped_at", rows[0].EquippedAt)
}

func TestCosmeticRepo_ServerSlotsResolution(t *testing.T) {
	db, path := newTestDBWithPath(t)
	seedCosmeticWorld(t, db)
	execSeed(t, db, []seedStmt{
		// dave: member of B, will look plain there.
		{`INSERT INTO users (id, username, password_hash) VALUES ('u-dave', 'dave', 'x')`, nil},
		{`INSERT INTO server_members (server_id, user_id) VALUES (?, 'u-dave')`, []any{emojiSrvB}},
	})
	repo := NewSQLiteCosmeticRepo(wrapForRepo(db))
	ctx := context.Background()

	aurora := builtinRow(t, repo, "b_frame_aurora")
	ember := builtinRow(t, repo, "b_frame_ember")
	dusk := builtinRow(t, repo, "b_plate_dusk")
	// alice: global aurora + dusk, B override ember.
	mustApplyEquip(t, repo, dmAlice, "", map[string]models.CosmeticEquipRow{
		models.CosmeticTypeAvatarFrame: aurora, models.CosmeticTypeNameplate: dusk}, nil)
	mustApplyEquip(t, repo, dmAlice, emojiSrvB, map[string]models.CosmeticEquipRow{models.CosmeticTypeAvatarFrame: ember}, nil)
	// bob: global aurora.
	mustApplyEquip(t, repo, dmBob, "", map[string]models.CosmeticEquipRow{models.CosmeticTypeAvatarFrame: aurora}, nil)
	// carol: global aurora, but not a member of B.
	mustApplyEquip(t, repo, dmCarol, "", map[string]models.CosmeticEquipRow{models.CosmeticTypeAvatarFrame: aurora}, nil)
	// dave: global aurora, plain in B.
	mustApplyEquip(t, repo, "u-dave", "", map[string]models.CosmeticEquipRow{models.CosmeticTypeAvatarFrame: aurora}, nil)
	if changed, err := repo.SetPlainServer(ctx, "u-dave", emojiSrvB, true); err != nil || !changed {
		t.Fatalf("SetPlainServer(dave, B) = %v, %v", changed, err)
	}
	// bob's B-scoped nameplate points at server A's item (planted with FKs
	// off, Equip never writes it): skipped in B.
	execWithoutFKs(t, path, `INSERT INTO user_equipped (user_id, scope_server_id, type, item_id, format, asset_snapshot)
		VALUES ('u-bob', 'emoji-srv-b', 'nameplate', 'aaaaaaaaaaaa0001', 'css', '`+cosPlateAsset+`')`)

	got, err := repo.ServerSlots(ctx, emojiSrvB)
	if err != nil {
		t.Fatalf("ServerSlots: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("ServerSlots(B) users = %v, want alice + bob only (carol not a member, dave plain)", got)
	}
	alice := got[dmAlice]
	if alice[models.CosmeticTypeAvatarFrame].ItemID != "b_frame_ember" || alice[models.CosmeticTypeNameplate].ItemID != "b_plate_dusk" {
		t.Errorf("alice in B = %+v, want ember override + global dusk", alice)
	}
	if string(alice[models.CosmeticTypeAvatarFrame].Asset) != `{"v":1,"frame":"ember"}` {
		t.Errorf("alice frame asset = %s", alice[models.CosmeticTypeAvatarFrame].Asset)
	}
	bob := got[dmBob]
	if len(bob) != 1 || bob[models.CosmeticTypeAvatarFrame].ItemID != "b_frame_aurora" {
		t.Errorf("bob in B = %+v, want only the global frame (foreign server item skipped)", bob)
	}

	// SlotsForUserInServer: same rule, plus the plain flag.
	slots, plain, err := repo.SlotsForUserInServer(ctx, dmAlice, emojiSrvB)
	if err != nil || plain || slots[models.CosmeticTypeAvatarFrame].ItemID != "b_frame_ember" {
		t.Errorf("SlotsForUserInServer(alice, B) = %+v, %v, %v", slots, plain, err)
	}
	slots, plain, err = repo.SlotsForUserInServer(ctx, "u-dave", emojiSrvB)
	if err != nil || !plain || len(slots) != 0 {
		t.Errorf("SlotsForUserInServer(dave, B) = %+v, %v, %v, want {} plain", slots, plain, err)
	}

	// GlobalSlotsForUsers: global scope only, users without slots left out.
	global, err := repo.GlobalSlotsForUsers(ctx, []string{dmAlice, dmBob, "u-nobody"})
	if err != nil {
		t.Fatalf("GlobalSlotsForUsers: %v", err)
	}
	if len(global) != 2 || global[dmAlice][models.CosmeticTypeAvatarFrame].ItemID != "b_frame_aurora" ||
		len(global[dmBob]) != 1 {
		t.Errorf("GlobalSlotsForUsers = %+v, want alice (aurora + dusk) and bob (aurora)", global)
	}
	if len(global[dmAlice]) != 2 {
		t.Errorf("alice global slots = %+v, want 2", global[dmAlice])
	}
}

func TestCosmeticRepo_PlainServers(t *testing.T) {
	db := newTestDB(t)
	seedCosmeticWorld(t, db)
	repo := NewSQLiteCosmeticRepo(wrapForRepo(db))
	ctx := context.Background()

	if ids, err := repo.ListPlainServers(ctx, dmAlice); err != nil || ids == nil || len(ids) != 0 {
		t.Fatalf("ListPlainServers(empty) = %#v, %v", ids, err)
	}
	if changed, err := repo.SetPlainServer(ctx, dmAlice, emojiSrvA, true); err != nil || !changed {
		t.Fatalf("SetPlainServer on = %v, %v", changed, err)
	}
	if changed, _ := repo.SetPlainServer(ctx, dmAlice, emojiSrvA, true); changed {
		t.Error("SetPlainServer on again: changed = true")
	}
	if ok, _ := repo.IsPlain(ctx, dmAlice, emojiSrvA); !ok {
		t.Error("IsPlain = false after switching on")
	}
	if ids, _ := repo.ListPlainServers(ctx, dmAlice); len(ids) != 1 || ids[0] != emojiSrvA {
		t.Errorf("ListPlainServers = %v", ids)
	}
	if changed, _ := repo.SetPlainServer(ctx, dmAlice, emojiSrvA, false); !changed {
		t.Error("SetPlainServer off: changed = false")
	}
	if changed, _ := repo.SetPlainServer(ctx, dmAlice, emojiSrvA, false); changed {
		t.Error("SetPlainServer off again: changed = true")
	}
}
