package models

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// The vectors below are shared verbatim with
// client/src/utils/cosmetics.test.ts (contract section 3).
func TestValidateCosmeticAsset_ValidVectorsAreCanonical(t *testing.T) {
	cases := []struct {
		typ, format, raw, want string
	}{
		{CosmeticTypeAvatarFrame, CosmeticFormatSVG, `{"v":1,"frame":"aurora"}`, `{"v":1,"frame":"aurora"}`},
		{CosmeticTypeNameplate, CosmeticFormatCSS,
			`{"v":1,"stops":["#2B1A4A","#6a2c70"],"angle":135,"pattern":"none"}`,
			`{"v":1,"stops":["#2b1a4a","#6a2c70"],"angle":135,"pattern":"none"}`},
		{CosmeticTypeNameplate, CosmeticFormatCSS,
			`{"v":1,"stops":["#000000","#111111","#222222"],"angle":0,"pattern":"dots"}`,
			`{"v":1,"stops":["#000000","#111111","#222222"],"angle":0,"pattern":"dots"}`},
		{CosmeticTypeNameStyle, CosmeticFormatCSS,
			`{"v":1,"font":"mono","stops":["#ffffff"],"angle":359}`,
			`{"v":1,"font":"mono","stops":["#ffffff"],"angle":359}`},
		{CosmeticTypeProfileTheme, CosmeticFormatCSS,
			`{"v":1,"accent":"#7c5cff","gradient":["#1a1033","#3a1c71"],"angle":160}`,
			`{"v":1,"accent":"#7c5cff","gradient":["#1a1033","#3a1c71"],"angle":160}`},
		{CosmeticTypeProfileEffect, CosmeticFormatCSS, `{"v":1,"effect":"snow","color":"#ffffff"}`,
			`{"v":1,"effect":"snow","color":"#ffffff"}`},
		// Field order and whitespace are normalized to the canonical form.
		{CosmeticTypeNameplate, CosmeticFormatCSS,
			` { "pattern":"grain", "angle":90, "stops":["#ABCDEF","#000000"], "v":1 } `,
			`{"v":1,"stops":["#abcdef","#000000"],"angle":90,"pattern":"grain"}`},
		{CosmeticTypeProfileTheme, CosmeticFormatCSS,
			`{"angle":1,"gradient":["#AAAAAA","#BBBBBB"],"accent":"#C0FFEE","v":1}`,
			`{"v":1,"accent":"#c0ffee","gradient":["#aaaaaa","#bbbbbb"],"angle":1}`},
	}
	for _, c := range cases {
		got, err := ValidateCosmeticAsset(c.typ, c.format, []byte(c.raw))
		if err != nil {
			t.Errorf("%s/%s %s: err = %v, want valid", c.typ, c.format, c.raw, err)
			continue
		}
		if string(got) != c.want {
			t.Errorf("%s/%s %s: canonical = %s, want %s", c.typ, c.format, c.raw, got, c.want)
		}
	}
}

func TestValidateCosmeticAsset_InvalidVectors(t *testing.T) {
	plate := func(stops string) string {
		return `{"v":1,"stops":` + stops + `,"angle":0,"pattern":"none"}`
	}
	plateAngle := func(angle string) string {
		return `{"v":1,"stops":["#000000","#111111"],"angle":` + angle + `,"pattern":"none"}`
	}
	cases := []struct {
		name, typ, format, raw string
	}{
		{"v 2", CosmeticTypeAvatarFrame, CosmeticFormatSVG, `{"v":2,"frame":"aurora"}`},
		{"v 1.0", CosmeticTypeAvatarFrame, CosmeticFormatSVG, `{"v":1.0,"frame":"aurora"}`},
		{"v string", CosmeticTypeAvatarFrame, CosmeticFormatSVG, `{"v":"1","frame":"aurora"}`},
		{"v null", CosmeticTypeAvatarFrame, CosmeticFormatSVG, `{"v":null,"frame":"aurora"}`},
		{"frame evil", CosmeticTypeAvatarFrame, CosmeticFormatSVG, `{"v":1,"frame":"evil"}`},
		{"frame doc as nameplate", CosmeticTypeNameplate, CosmeticFormatCSS, `{"v":1,"frame":"aurora"}`},
		{"frame doc as nameplate svg", CosmeticTypeNameplate, CosmeticFormatSVG, `{"v":1,"frame":"aurora"}`},
		{"css frame", CosmeticTypeAvatarFrame, CosmeticFormatCSS, `{"v":1,"frame":"aurora"}`},
		{"upper-case key", CosmeticTypeAvatarFrame, CosmeticFormatSVG, `{"V":1,"frame":"aurora"}`},
		{"missing field", CosmeticTypeAvatarFrame, CosmeticFormatSVG, `{"v":1}`},
		{"one stop", CosmeticTypeNameplate, CosmeticFormatCSS, plate(`["#000000"]`)},
		{"four stops", CosmeticTypeNameplate, CosmeticFormatCSS, plate(`["#000000","#111111","#222222","#333333"]`)},
		{"short hex", CosmeticTypeNameplate, CosmeticFormatCSS, plate(`["#fff","#000000"]`)},
		{"named color", CosmeticTypeNameplate, CosmeticFormatCSS, plate(`["red","#000000"]`)},
		{"bad hex digit", CosmeticTypeNameplate, CosmeticFormatCSS, plate(`["#12345g","#000000"]`)},
		{"css url", CosmeticTypeNameplate, CosmeticFormatCSS, plate(`["url(x)","#000000"]`)},
		{"null stop", CosmeticTypeNameplate, CosmeticFormatCSS, plate(`[null,"#000000"]`)},
		{"angle 360", CosmeticTypeNameplate, CosmeticFormatCSS, plateAngle(`360`)},
		{"angle -1", CosmeticTypeNameplate, CosmeticFormatCSS, plateAngle(`-1`)},
		{"angle 1.5", CosmeticTypeNameplate, CosmeticFormatCSS, plateAngle(`1.5`)},
		{"angle string", CosmeticTypeNameplate, CosmeticFormatCSS, plateAngle(`"90"`)},
		{"pattern zigzag", CosmeticTypeNameplate, CosmeticFormatCSS,
			`{"v":1,"stops":["#000000","#111111"],"angle":0,"pattern":"zigzag"}`},
		{"font comic", CosmeticTypeNameStyle, CosmeticFormatCSS, `{"v":1,"font":"comic","stops":["#ffffff"],"angle":0}`},
		{"name style three stops", CosmeticTypeNameStyle, CosmeticFormatCSS,
			`{"v":1,"font":"default","stops":["#ffffff","#ffffff","#ffffff"],"angle":0}`},
		{"name style unreadable", CosmeticTypeNameStyle, CosmeticFormatCSS, `{"v":1,"font":"default","stops":["#a0a0a0"],"angle":0}`},
		{"theme one stop", CosmeticTypeProfileTheme, CosmeticFormatCSS,
			`{"v":1,"accent":"#7c5cff","gradient":["#1a1033"],"angle":160}`},
		{"effect fire", CosmeticTypeProfileEffect, CosmeticFormatCSS, `{"v":1,"effect":"fire","color":"#ffffff"}`},
		{"unknown field", CosmeticTypeProfileEffect, CosmeticFormatCSS, `{"v":1,"effect":"snow","color":"#ffffff","css":"x"}`},
		{"null", CosmeticTypeProfileEffect, CosmeticFormatCSS, `null`},
		{"array", CosmeticTypeProfileEffect, CosmeticFormatCSS, `[{"v":1,"effect":"snow","color":"#ffffff"}]`},
		{"not json", CosmeticTypeProfileEffect, CosmeticFormatCSS, `{v:1}`},
		{"trailing data", CosmeticTypeProfileEffect, CosmeticFormatCSS, `{"v":1,"effect":"snow","color":"#ffffff"} {}`},
		{"empty", CosmeticTypeProfileEffect, CosmeticFormatCSS, ``},
		{"raster from a client", CosmeticTypeAvatarFrame, CosmeticFormatRaster,
			`{"v":1,"url":"/api/uploads/cosmetics/0123456789abcdef.png"}`},
		{"unknown type", "badge", CosmeticFormatCSS, `{"v":1,"effect":"snow","color":"#ffffff"}`},
	}
	for _, c := range cases {
		if _, err := ValidateCosmeticAsset(c.typ, c.format, []byte(c.raw)); !errors.Is(err, ErrCosmeticAssetInvalid) {
			t.Errorf("%s: err = %v, want ErrCosmeticAssetInvalid", c.name, err)
		}
	}
}

func TestValidateCosmeticAsset_SizeCap(t *testing.T) {
	base := `{"v":1,"effect":"snow","color":"#ffffff"}`
	pad := func(n int) string { return base[:1] + strings.Repeat(" ", n-len(base)) + base[1:] }
	if _, err := ValidateCosmeticAsset(CosmeticTypeProfileEffect, CosmeticFormatCSS, []byte(pad(CosmeticAssetMaxBytes))); err != nil {
		t.Errorf("512-byte document: err = %v, want valid", err)
	}
	if _, err := ValidateCosmeticAsset(CosmeticTypeProfileEffect, CosmeticFormatCSS, []byte(pad(CosmeticAssetMaxBytes+1))); !errors.Is(err, ErrCosmeticAssetInvalid) {
		t.Errorf("513-byte document: err = %v, want ErrCosmeticAssetInvalid", err)
	}
}

func TestBuildRasterFrameAsset(t *testing.T) {
	png := "/api/uploads/cosmetics/0123456789abcdef.png"
	gif := "/api/uploads/cosmetics/0123456789abcdef.gif"
	got, err := BuildRasterFrameAsset(png, "")
	if err != nil || string(got) != `{"v":1,"url":"`+png+`"}` {
		t.Errorf("static = %s, %v", got, err)
	}
	got, err = BuildRasterFrameAsset(png, gif)
	if err != nil || string(got) != `{"v":1,"url":"`+png+`","animated_url":"`+gif+`"}` {
		t.Errorf("animated = %s, %v", got, err)
	}
	for _, bad := range [][2]string{
		{"/api/uploads/cosmetics/../avatar.png", ""},
		{"/api/uploads/cosmetics/0123456789ABCDEF.png", ""},
		{gif, ""},
		{png, png},
		{"https://evil.example/x.png", ""},
	} {
		if _, err := BuildRasterFrameAsset(bad[0], bad[1]); !errors.Is(err, ErrCosmeticAssetInvalid) {
			t.Errorf("BuildRasterFrameAsset(%q, %q): err = %v, want ErrCosmeticAssetInvalid", bad[0], bad[1], err)
		}
	}
	// A stored raster snapshot round-trips; an off-pattern one is rejected.
	stored, err := ValidateStoredCosmeticAsset(CosmeticTypeAvatarFrame, CosmeticFormatRaster,
		[]byte(`{"animated_url":"`+gif+`","url":"`+png+`","v":1}`))
	if err != nil || string(stored) != `{"v":1,"url":"`+png+`","animated_url":"`+gif+`"}` {
		t.Errorf("stored raster = %s, %v", stored, err)
	}
	if _, err := ValidateStoredCosmeticAsset(CosmeticTypeAvatarFrame, CosmeticFormatRaster,
		[]byte(`{"v":1,"url":"/api/uploads/avatars/x.png"}`)); err == nil {
		t.Error("off-pattern stored raster accepted")
	}
}

func TestEquipRequest_Validate(t *testing.T) {
	id := "b_frame_aurora"
	bad := "has space"
	cases := []struct {
		name string
		req  EquipRequest
		ok   bool
	}{
		{"global one slot", EquipRequest{Scope: "global", Slots: map[string]*string{"avatar_frame": &id}}, true},
		{"server clear", EquipRequest{Scope: "srv-1", Slots: map[string]*string{"nameplate": nil}}, true},
		{"all five", EquipRequest{Scope: "global", Slots: map[string]*string{
			"avatar_frame": &id, "nameplate": nil, "name_style": nil, "profile_theme": nil, "profile_effect": nil}}, true},
		{"no slots", EquipRequest{Scope: "global", Slots: map[string]*string{}}, false},
		{"unknown key", EquipRequest{Scope: "global", Slots: map[string]*string{"badge": &id}}, false},
		{"empty scope", EquipRequest{Scope: "", Slots: map[string]*string{"nameplate": nil}}, false},
		{"bad scope", EquipRequest{Scope: "../x", Slots: map[string]*string{"nameplate": nil}}, false},
		{"bad id", EquipRequest{Scope: "global", Slots: map[string]*string{"nameplate": &bad}}, false},
	}
	for _, c := range cases {
		err := c.req.Validate()
		if c.ok && err != nil {
			t.Errorf("%s: err = %v, want nil", c.name, err)
		}
		if !c.ok && !errors.Is(err, ErrCosmeticSlotsInvalid) {
			t.Errorf("%s: err = %v, want ErrCosmeticSlotsInvalid", c.name, err)
		}
	}
}

func TestCosmeticSlots_NilMarshalsAsEmptyObject(t *testing.T) {
	out, err := json.Marshal(CosmeticsUpdateEvent{UserID: "u"})
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != `{"user_id":"u","server_id":null,"slots":{},"plain":false}` {
		t.Errorf("event = %s", out)
	}
}

func TestResolveCosmeticSlots(t *testing.T) {
	srv, other := "srv-1", "srv-2"
	frameA := `{"v":1,"frame":"aurora"}`
	frameB := `{"v":1,"frame":"ember"}`
	plate := `{"v":1,"stops":["#000000","#111111"],"angle":0,"pattern":"none"}`
	rows := []CosmeticEquippedRow{
		{ScopeServerID: "", Type: CosmeticTypeAvatarFrame, ItemID: "g-frame", Format: "svg", AssetSnapshot: frameA},
		{ScopeServerID: "", Type: CosmeticTypeNameplate, ItemID: "g-plate", Format: "css", AssetSnapshot: plate},
		{ScopeServerID: srv, Type: CosmeticTypeAvatarFrame, ItemID: "s-frame", Format: "svg", AssetSnapshot: frameB},
		// a server row pointing at another server's item is skipped
		{ScopeServerID: srv, Type: CosmeticTypeNameplate, ItemID: "x", Format: "css", AssetSnapshot: plate, ItemServerID: &other},
		// a global row pointing at a server item is skipped
		{ScopeServerID: "", Type: CosmeticTypeProfileEffect, ItemID: "y", Format: "css",
			AssetSnapshot: `{"v":1,"effect":"snow","color":"#ffffff"}`, ItemServerID: &srv},
		// a corrupt snapshot is skipped
		{ScopeServerID: "", Type: CosmeticTypeProfileTheme, ItemID: "z", Format: "css", AssetSnapshot: `{"v":1}`},
	}
	in := ResolveCosmeticSlots(rows, srv)
	if len(in) != 2 || in[CosmeticTypeAvatarFrame].ItemID != "s-frame" || in[CosmeticTypeNameplate].ItemID != "g-plate" {
		t.Errorf("server context = %+v, want override frame + global plate", in)
	}
	global := ResolveCosmeticSlots(rows, "")
	if len(global) != 2 || global[CosmeticTypeAvatarFrame].ItemID != "g-frame" {
		t.Errorf("global context = %+v, want the two valid global rows", global)
	}
}
