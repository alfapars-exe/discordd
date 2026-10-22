package services

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

// cosmeticFixture wires the REAL cosmetic service and the everyone-mode
// entitlements over testutil mocks backed by a small in-memory store, so
// "changed" and the resolved WS payloads come out of the same rules the
// SQLite repo applies.
type cosmeticFixture struct {
	mu       sync.Mutex
	items    map[string]*models.CosmeticItem
	members  map[string][]string // userID -> server ids
	grants   map[string]bool     // userID|itemID
	equipped map[string]map[string]models.CosmeticEquipRow
	plain    map[string]bool // userID|serverID

	repo   *testutil.MockCosmeticRepo
	server *testutil.MockServerRepo

	toUser   []ws.Event
	toServer map[string][]ws.Event
	svc      CosmeticService
}

func cosmeticStrPtr(s string) *string { return &s }

func newCosmeticFixture() *cosmeticFixture {
	f := &cosmeticFixture{
		items: map[string]*models.CosmeticItem{
			"b_frame_aurora": {ID: "b_frame_aurora", Type: models.CosmeticTypeAvatarFrame, Format: models.CosmeticFormatSVG,
				Availability: "free", Animated: true, AssetJSON: cosmeticStrPtr(`{"v":1,"frame":"aurora"}`)},
			"b_plate_dusk": {ID: "b_plate_dusk", Type: models.CosmeticTypeNameplate, Format: models.CosmeticFormatCSS,
				Availability: "free", AssetJSON: cosmeticStrPtr(`{"v":1,"stops":["#2b1a4a","#6a2c70"],"angle":135,"pattern":"none"}`)},
			"b_name_gold": {ID: "b_name_gold", Type: models.CosmeticTypeNameStyle, Format: models.CosmeticFormatCSS,
				Availability: "free", AssetJSON: cosmeticStrPtr(`{"v":1,"font":"bold","stops":["#ffd166","#ffb703"],"angle":90}`)},
			"b_name_ice": {ID: "b_name_ice", Type: models.CosmeticTypeNameStyle, Format: models.CosmeticFormatCSS,
				Availability: "free", AssetJSON: cosmeticStrPtr(`{"v":1,"font":"default","stops":["#a8e6ff","#e0f7ff"],"angle":90}`)},
			"s1free": {ID: "s1free", ServerID: cosmeticStrPtr("srv1"), Type: models.CosmeticTypeNameplate, Format: models.CosmeticFormatCSS,
				Availability: "free", AssetJSON: cosmeticStrPtr(`{"v":1,"stops":["#000000","#111111"],"angle":0,"pattern":"dots"}`)},
			"s1granted": {ID: "s1granted", ServerID: cosmeticStrPtr("srv1"), Type: models.CosmeticTypeProfileEffect, Format: models.CosmeticFormatCSS,
				Availability: "granted", Animated: true, AssetJSON: cosmeticStrPtr(`{"v":1,"effect":"snow","color":"#ffffff"}`)},
		},
		members:  map[string][]string{"u1": {"srv1", "srv2"}},
		grants:   map[string]bool{},
		equipped: map[string]map[string]models.CosmeticEquipRow{},
		plain:    map[string]bool{},
		toServer: map[string][]ws.Event{},
	}
	f.repo = &testutil.MockCosmeticRepo{
		GetItemFn: func(_ context.Context, id string) (*models.CosmeticItem, error) {
			it, ok := f.items[id]
			if !ok {
				return nil, models.ErrCosmeticItemNotFound
			}
			cp := *it
			return &cp, nil
		},
		HasGrantFn: func(_ context.Context, userID, itemID string) (bool, error) {
			return f.grants[userID+"|"+itemID], nil
		},
		ListEquippedFn: func(_ context.Context, userID string) ([]models.CosmeticEquippedRow, error) {
			return f.rows(userID), nil
		},
		ApplyEquipFn: func(_ context.Context, userID, scope string, set map[string]models.CosmeticEquipRow, unset []string) (bool, error) {
			f.mu.Lock()
			defer f.mu.Unlock()
			key := userID + "|" + scope
			cur := f.equipped[key]
			if cur == nil {
				cur = map[string]models.CosmeticEquipRow{}
				f.equipped[key] = cur
			}
			changed := false
			for typ, row := range set {
				if have, ok := cur[typ]; !ok || have != row {
					cur[typ] = row
					changed = true
				}
			}
			for _, typ := range unset {
				if _, ok := cur[typ]; ok {
					delete(cur, typ)
					changed = true
				}
			}
			return changed, nil
		},
		SetPlainServerFn: func(_ context.Context, userID, serverID string, plain bool) (bool, error) {
			key := userID + "|" + serverID
			if f.plain[key] == plain {
				return false, nil
			}
			f.plain[key] = plain
			return true, nil
		},
		SlotsForUserInServerFn: func(_ context.Context, userID, serverID string) (models.CosmeticSlots, bool, error) {
			if f.plain[userID+"|"+serverID] {
				return models.CosmeticSlots{}, true, nil
			}
			return models.ResolveCosmeticSlots(f.rows(userID), serverID), false, nil
		},
		ServerSlotsFn: func(_ context.Context, serverID string) (map[string]models.CosmeticSlots, error) {
			out := map[string]models.CosmeticSlots{}
			for userID, servers := range f.members {
				if !cosmeticContains(servers, serverID) || f.plain[userID+"|"+serverID] {
					continue
				}
				if s := models.ResolveCosmeticSlots(f.rows(userID), serverID); len(s) > 0 {
					out[userID] = s
				}
			}
			return out, nil
		},
	}
	f.server = &testutil.MockServerRepo{
		IsMemberFn: func(_ context.Context, serverID, userID string) (bool, error) {
			return cosmeticContains(f.members[userID], serverID), nil
		},
		GetUserServersFn: func(_ context.Context, userID string) ([]models.ServerListItem, error) {
			out := []models.ServerListItem{}
			for _, id := range f.members[userID] {
				out = append(out, models.ServerListItem{ID: id})
			}
			return out, nil
		},
	}
	hub := &testutil.MockBroadcaster{
		BroadcastToUserFn: func(_ string, e ws.Event) { f.toUser = append(f.toUser, e) },
		BroadcastToServerFn: func(serverID string, e ws.Event) {
			f.toServer[serverID] = append(f.toServer[serverID], e)
		},
	}
	f.svc = NewCosmeticService(f.repo, f.server, NewEveryoneCosmeticEntitlements(f.repo, f.server), hub)
	return f
}

func cosmeticContains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// rows renders the in-memory store as ListEquipped rows (item server_id
// joined, like the SQLite repo).
func (f *cosmeticFixture) rows(userID string) []models.CosmeticEquippedRow {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := []models.CosmeticEquippedRow{}
	for key, slots := range f.equipped {
		u, scope, _ := strings.Cut(key, "|")
		if u != userID {
			continue
		}
		for typ, r := range slots {
			out = append(out, models.CosmeticEquippedRow{
				UserID: userID, ScopeServerID: scope, Type: typ, ItemID: r.ItemID, Format: r.Format,
				Animated: r.Animated, AssetSnapshot: r.AssetSnapshot, ItemServerID: f.items[r.ItemID].ServerID,
			})
		}
	}
	return out
}

func (f *cosmeticFixture) events() int {
	n := len(f.toUser)
	for _, list := range f.toServer {
		n += len(list)
	}
	return n
}

func (f *cosmeticFixture) reset() {
	f.toUser = nil
	f.toServer = map[string][]ws.Event{}
}

func equipReq(scope string, slots map[string]*string) *models.EquipRequest {
	return &models.EquipRequest{Scope: scope, Slots: slots}
}

func TestCosmeticService_GlobalEquipBroadcastsOncePerServerAndSelf(t *testing.T) {
	f := newCosmeticFixture()
	mine, err := f.svc.Equip(context.Background(), "u1", equipReq("global",
		map[string]*string{"avatar_frame": cosmeticStrPtr("b_frame_aurora")}))
	if err != nil {
		t.Fatalf("Equip: %v", err)
	}
	if got := mine.Equipped.Global["avatar_frame"].ItemID; got != "b_frame_aurora" {
		t.Fatalf("global avatar_frame = %q", got)
	}
	if string(mine.Equipped.Global["avatar_frame"].Asset) != `{"v":1,"frame":"aurora"}` {
		t.Fatalf("snapshot asset = %s", mine.Equipped.Global["avatar_frame"].Asset)
	}
	if len(f.toUser) != 1 {
		t.Fatalf("self events = %d, want 1", len(f.toUser))
	}
	self := f.toUser[0].Data.(models.CosmeticsUpdateEvent)
	if f.toUser[0].Op != ws.OpUserCosmeticsUpdate || self.ServerID != nil || self.UserID != "u1" {
		t.Fatalf("self event = %+v", f.toUser[0])
	}
	for _, s := range []string{"srv1", "srv2"} {
		if len(f.toServer[s]) != 1 {
			t.Fatalf("%s events = %d, want 1", s, len(f.toServer[s]))
		}
		ev := f.toServer[s][0].Data.(models.CosmeticsUpdateEvent)
		if ev.ServerID == nil || *ev.ServerID != s || ev.Plain || ev.Slots["avatar_frame"].ItemID != "b_frame_aurora" {
			t.Fatalf("%s event = %+v", s, ev)
		}
	}

	// The same request again changes nothing -> no broadcast.
	f.reset()
	if _, err := f.svc.Equip(context.Background(), "u1", equipReq("global",
		map[string]*string{"avatar_frame": cosmeticStrPtr("b_frame_aurora")})); err != nil {
		t.Fatalf("Equip again: %v", err)
	}
	if n := f.events(); n != 0 {
		t.Fatalf("no-op equip broadcast %d events", n)
	}
}

func TestCosmeticService_ThreeSlotsOneEventPerServer(t *testing.T) {
	f := newCosmeticFixture()
	_, err := f.svc.Equip(context.Background(), "u1", equipReq("global", map[string]*string{
		"avatar_frame": cosmeticStrPtr("b_frame_aurora"),
		"nameplate":    cosmeticStrPtr("b_plate_dusk"),
		"name_style":   cosmeticStrPtr("b_name_gold"),
	}))
	if err != nil {
		t.Fatalf("Equip: %v", err)
	}
	if len(f.toUser) != 1 || len(f.toServer["srv1"]) != 1 || len(f.toServer["srv2"]) != 1 {
		t.Fatalf("events self=%d srv1=%d srv2=%d, want 1 each", len(f.toUser), len(f.toServer["srv1"]), len(f.toServer["srv2"]))
	}
	if n := len(f.toServer["srv1"][0].Data.(models.CosmeticsUpdateEvent).Slots); n != 3 {
		t.Fatalf("srv1 slots = %d, want 3", n)
	}

	// Unset (null) is a change too.
	f.reset()
	mine, err := f.svc.Equip(context.Background(), "u1", equipReq("global", map[string]*string{"nameplate": nil}))
	if err != nil {
		t.Fatalf("unset: %v", err)
	}
	if _, ok := mine.Equipped.Global["nameplate"]; ok {
		t.Fatal("nameplate still equipped after null")
	}
	if len(f.toUser) != 1 {
		t.Fatalf("unset self events = %d, want 1", len(f.toUser))
	}
}

func TestCosmeticService_ServerScopeBroadcastsOnlyThatServer(t *testing.T) {
	f := newCosmeticFixture()
	_, err := f.svc.Equip(context.Background(), "u1", equipReq("srv1",
		map[string]*string{"nameplate": cosmeticStrPtr("s1free")}))
	if err != nil {
		t.Fatalf("Equip free server item: %v", err)
	}
	if len(f.toUser) != 0 || len(f.toServer["srv2"]) != 0 || len(f.toServer["srv1"]) != 1 {
		t.Fatalf("events self=%d srv1=%d srv2=%d", len(f.toUser), len(f.toServer["srv1"]), len(f.toServer["srv2"]))
	}
}

func TestCosmeticService_EquipErrors(t *testing.T) {
	cases := []struct {
		name  string
		req   *models.EquipRequest
		setup func(f *cosmeticFixture)
		want  error
	}{
		{"type mismatch", equipReq("global", map[string]*string{"nameplate": cosmeticStrPtr("b_frame_aurora")}), nil, models.ErrCosmeticSlotMismatch},
		{"missing item", equipReq("global", map[string]*string{"nameplate": cosmeticStrPtr("nope")}), nil, models.ErrCosmeticNotFound},
		{"non-member scope", equipReq("srv3", map[string]*string{"nameplate": cosmeticStrPtr("b_plate_dusk")}), nil, models.ErrCosmeticNotFound},
		{"server item to global", equipReq("global", map[string]*string{"nameplate": cosmeticStrPtr("s1free")}), nil, models.ErrCosmeticScopeMismatch},
		{"server item to other server", equipReq("srv2", map[string]*string{"nameplate": cosmeticStrPtr("s1free")}), nil, models.ErrCosmeticScopeMismatch},
		{"granted without grant", equipReq("srv1", map[string]*string{"profile_effect": cosmeticStrPtr("s1granted")}), nil, models.ErrCosmeticNotOwned},
		{"entitlement denies", equipReq("global", map[string]*string{"nameplate": cosmeticStrPtr("b_plate_dusk")}),
			func(f *cosmeticFixture) {
				f.svc = NewCosmeticService(f.repo, f.server, denyAllEntitlements{}, &testutil.MockBroadcaster{})
			}, models.ErrCosmeticNotOwned},
		{"unknown slot key", equipReq("global", map[string]*string{"halo": cosmeticStrPtr("b_frame_aurora")}), nil, models.ErrCosmeticSlotsInvalid},
		{"no slots", equipReq("global", map[string]*string{}), nil, models.ErrCosmeticSlotsInvalid},
		{"bad scope", equipReq("srv 1", map[string]*string{"nameplate": nil}), nil, models.ErrCosmeticSlotsInvalid},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newCosmeticFixture()
			if tc.setup != nil {
				tc.setup(f)
			}
			_, err := f.svc.Equip(context.Background(), "u1", tc.req)
			if !errors.Is(err, tc.want) {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}
			if n := f.events(); n != 0 {
				t.Fatalf("failed equip broadcast %d events", n)
			}
		})
	}
}

func TestCosmeticService_NotFoundIsIdenticalForMissingItemAndNonMember(t *testing.T) {
	f := newCosmeticFixture()
	_, errItem := f.svc.Equip(context.Background(), "u1", equipReq("global", map[string]*string{"nameplate": cosmeticStrPtr("nope")}))
	_, errScope := f.svc.Equip(context.Background(), "u1", equipReq("srv3", map[string]*string{"nameplate": cosmeticStrPtr("b_plate_dusk")}))
	if errItem == nil || errScope == nil || errItem.Error() != errScope.Error() {
		t.Fatalf("404 messages differ: %v vs %v", errItem, errScope)
	}
}

func TestCosmeticService_GrantedItemWithGrant(t *testing.T) {
	f := newCosmeticFixture()
	f.grants["u1|s1granted"] = true
	mine, err := f.svc.Equip(context.Background(), "u1", equipReq("srv1",
		map[string]*string{"profile_effect": cosmeticStrPtr("s1granted")}))
	if err != nil {
		t.Fatalf("Equip granted: %v", err)
	}
	if got := mine.Equipped.Servers["srv1"]["profile_effect"].ItemID; got != "s1granted" {
		t.Fatalf("srv1 profile_effect = %q", got)
	}
}

func TestCosmeticService_SetPlainServer(t *testing.T) {
	f := newCosmeticFixture()
	if _, err := f.svc.Equip(context.Background(), "u1", equipReq("global",
		map[string]*string{"avatar_frame": cosmeticStrPtr("b_frame_aurora")})); err != nil {
		t.Fatalf("Equip: %v", err)
	}
	f.reset()

	if err := f.svc.SetPlainServer(context.Background(), "u1", "srv1", true); err != nil {
		t.Fatalf("SetPlainServer: %v", err)
	}
	if len(f.toUser) != 0 || len(f.toServer["srv2"]) != 0 || len(f.toServer["srv1"]) != 1 {
		t.Fatalf("events self=%d srv1=%d srv2=%d", len(f.toUser), len(f.toServer["srv1"]), len(f.toServer["srv2"]))
	}
	ev := f.toServer["srv1"][0].Data.(models.CosmeticsUpdateEvent)
	if !ev.Plain || len(ev.Slots) != 0 || ev.Slots == nil {
		t.Fatalf("plain event = %+v", ev)
	}

	// Already plain -> no broadcast.
	f.reset()
	if err := f.svc.SetPlainServer(context.Background(), "u1", "srv1", true); err != nil {
		t.Fatalf("SetPlainServer again: %v", err)
	}
	if n := f.events(); n != 0 {
		t.Fatalf("no-op plain broadcast %d events", n)
	}

	// Not a member -> the shared 404.
	if err := f.svc.SetPlainServer(context.Background(), "u1", "srv3", true); !errors.Is(err, models.ErrCosmeticNotFound) {
		t.Fatalf("non-member err = %v", err)
	}
}

func TestCosmeticService_ServerCosmeticsResolution(t *testing.T) {
	f := newCosmeticFixture()
	f.members["u2"] = []string{"srv1"}
	f.members["u3"] = []string{"srv1"}
	ctx := context.Background()
	mustEquip := func(user, scope, typ, id string) {
		t.Helper()
		if _, err := f.svc.Equip(ctx, user, equipReq(scope, map[string]*string{typ: cosmeticStrPtr(id)})); err != nil {
			t.Fatalf("Equip %s %s: %v", user, id, err)
		}
	}
	mustEquip("u1", "global", "name_style", "b_name_gold")
	mustEquip("u1", "srv1", "name_style", "b_name_ice")
	mustEquip("u1", "global", "avatar_frame", "b_frame_aurora")
	mustEquip("u2", "global", "nameplate", "b_plate_dusk")
	if err := f.svc.SetPlainServer(ctx, "u2", "srv1", true); err != nil {
		t.Fatalf("plain: %v", err)
	}

	res, err := f.svc.ServerCosmetics(ctx, "srv1")
	if err != nil {
		t.Fatalf("ServerCosmetics: %v", err)
	}
	if res.ServerID != "srv1" {
		t.Fatalf("server_id = %q", res.ServerID)
	}
	u1 := res.Users["u1"]
	if u1["name_style"].ItemID != "b_name_ice" || u1["avatar_frame"].ItemID != "b_frame_aurora" {
		t.Fatalf("u1 resolved = %+v (override must win, global must fill)", u1)
	}
	if _, ok := res.Users["u2"]; ok {
		t.Fatal("plain member u2 must be left out")
	}
	if _, ok := res.Users["u3"]; ok {
		t.Fatal("member without slots must be left out")
	}
}

type denyAllEntitlements struct{}

func (denyAllEntitlements) CanWear(context.Context, string, *models.CosmeticItem) (bool, error) {
	return false, nil
}

func TestEveryoneCosmeticEntitlements(t *testing.T) {
	f := newCosmeticFixture()
	ent := NewEveryoneCosmeticEntitlements(f.repo, f.server)
	ctx := context.Background()
	cases := []struct {
		name string
		user string
		item string
		want bool
	}{
		{"builtin", "outsider", "b_frame_aurora", true},
		{"free server item, member", "u1", "s1free", true},
		{"free server item, non-member", "outsider", "s1free", false},
		{"granted item, no grant", "u1", "s1granted", false},
	}
	for _, tc := range cases {
		got, err := ent.CanWear(ctx, tc.user, f.items[tc.item])
		if err != nil || got != tc.want {
			t.Errorf("%s: CanWear = %v, %v; want %v", tc.name, got, err, tc.want)
		}
	}
	f.grants["u1|s1granted"] = true
	if ok, _ := ent.CanWear(ctx, "u1", f.items["s1granted"]); !ok {
		t.Error("granted item with grant must be wearable")
	}
	f.grants["outsider|s1granted"] = true
	if ok, _ := ent.CanWear(ctx, "outsider", f.items["s1granted"]); ok {
		t.Error("a grant without membership must not be wearable")
	}
}

func TestCosmeticService_LookupGlobalBounds(t *testing.T) {
	f := newCosmeticFixture()
	ctx := context.Background()
	var gotIDs []string
	f.repo.GlobalSlotsForUsersFn = func(_ context.Context, ids []string) (map[string]models.CosmeticSlots, error) {
		gotIDs = ids
		return nil, nil
	}

	if _, err := f.svc.LookupGlobal(ctx, nil); !errors.Is(err, models.ErrCosmeticIDsInvalid) {
		t.Fatalf("0 ids err = %v", err)
	}
	many := make([]string, 101)
	for i := range many {
		many[i] = "u" + string(rune('a'+i%26)) + string(rune('a'+i/26))
	}
	if _, err := f.svc.LookupGlobal(ctx, many); !errors.Is(err, models.ErrCosmeticIDsInvalid) {
		t.Fatalf("101 ids err = %v", err)
	}
	if _, err := f.svc.LookupGlobal(ctx, []string{"ok", "bad id"}); !errors.Is(err, models.ErrCosmeticIDsInvalid) {
		t.Fatalf("malformed id err = %v", err)
	}
	if _, err := f.svc.LookupGlobal(ctx, []string{"a", ""}); !errors.Is(err, models.ErrCosmeticIDsInvalid) {
		t.Fatalf("empty id err = %v", err)
	}

	dups := make([]string, 150)
	for i := range dups {
		dups[i] = "same"
	}
	res, err := f.svc.LookupGlobal(ctx, dups)
	if err != nil {
		t.Fatalf("duplicates err = %v", err)
	}
	if len(gotIDs) != 1 || gotIDs[0] != "same" {
		t.Fatalf("repo ids = %v, want [same]", gotIDs)
	}
	if res.Users == nil {
		t.Fatal("users must be {} not null")
	}
}

func TestCosmeticService_GetMineShapes(t *testing.T) {
	f := newCosmeticFixture()
	f.repo.ListBuiltinItemsFn = func(context.Context) ([]models.CosmeticItem, error) {
		return []models.CosmeticItem{*f.items["b_frame_aurora"], {ID: "b_broken", Type: models.CosmeticTypeNameplate,
			Format: models.CosmeticFormatCSS, AssetJSON: cosmeticStrPtr(`{"v":2}`)}}, nil
	}
	mine, err := f.svc.GetMine(context.Background(), "u1")
	if err != nil {
		t.Fatalf("GetMine: %v", err)
	}
	if len(mine.Items) != 1 || mine.Items[0].ID != "b_frame_aurora" || string(mine.Items[0].Asset) != `{"v":1,"frame":"aurora"}` {
		t.Fatalf("items = %+v (invalid stored item must be skipped)", mine.Items)
	}
	if mine.Grants == nil || mine.PlainServerIDs == nil || mine.Equipped.Servers == nil {
		t.Fatalf("empty lists/maps must be non-nil: %+v", mine)
	}
}
