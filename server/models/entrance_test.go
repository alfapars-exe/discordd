package models

import (
	"errors"
	"strings"
	"testing"
)

// Contract §6 vectors — client utils/entrancePreset.ts parseEntrancePreset
// mirrors these one to one.
func TestValidateEntrancePreset_Valid(t *testing.T) {
	cases := []struct {
		raw, canonical string
	}{
		{`{"v":1,"theme":"chime","waveform":"sine","pitch":0,"duration_ms":150}`,
			`{"v":1,"theme":"chime","waveform":"sine","pitch":0,"duration_ms":150}`},
		{`{"v":1,"theme":"fanfare","waveform":"sawtooth","pitch":-12,"duration_ms":2000}`,
			`{"v":1,"theme":"fanfare","waveform":"sawtooth","pitch":-12,"duration_ms":2000}`},
		{`{"v":1,"theme":"fanfare","waveform":"sawtooth","pitch":12,"duration_ms":2000}`,
			`{"v":1,"theme":"fanfare","waveform":"sawtooth","pitch":12,"duration_ms":2000}`},
		// Field order and whitespace are normalized to the canonical form.
		{` { "duration_ms": 800, "pitch": 3, "waveform": "triangle", "theme": "bell", "v": 1 } `,
			`{"v":1,"theme":"bell","waveform":"triangle","pitch":3,"duration_ms":800}`},
	}
	for _, c := range cases {
		p, canonical, err := ValidateEntrancePreset([]byte(c.raw))
		if err != nil {
			t.Errorf("ValidateEntrancePreset(%s) error: %v", c.raw, err)
			continue
		}
		if string(canonical) != c.canonical {
			t.Errorf("canonical(%s) = %s, want %s", c.raw, canonical, c.canonical)
		}
		if p.V != 1 {
			t.Errorf("preset v = %d, want 1", p.V)
		}
	}
}

func TestValidateEntrancePreset_Invalid(t *testing.T) {
	base := func(field, value string) string {
		fields := map[string]string{
			"v": "1", "theme": `"chime"`, "waveform": `"sine"`, "pitch": "0", "duration_ms": "800",
		}
		fields[field] = value
		order := []string{"v", "theme", "waveform", "pitch", "duration_ms"}
		parts := make([]string, 0, len(order))
		for _, k := range order {
			parts = append(parts, `"`+k+`":`+fields[k])
		}
		return "{" + strings.Join(parts, ",") + "}"
	}
	long := `{"v":1,"theme":"chime","waveform":"sine","pitch":0,"duration_ms":800}`
	long = long[:len(long)-1] + strings.Repeat(" ", 257-len(long)) + "}"
	if len(long) != 257 {
		t.Fatalf("fixture length = %d, want 257", len(long))
	}

	cases := map[string]string{
		"v 2":                base("v", "2"),
		"theme siren":        base("theme", `"siren"`),
		"waveform noise":     base("waveform", `"noise"`),
		"pitch 13":           base("pitch", "13"),
		"pitch -13":          base("pitch", "-13"),
		"pitch 1.5":          base("pitch", "1.5"),
		"duration 149":       base("duration_ms", "149"),
		"duration 2001":      base("duration_ms", "2001"),
		"duration string":    base("duration_ms", `"800"`),
		"unknown field gain": `{"v":1,"theme":"chime","waveform":"sine","pitch":0,"duration_ms":800,"gain":5}`,
		"missing field":      `{"v":1,"theme":"chime","waveform":"sine","pitch":0}`,
		"not json":           `chime please`,
		"257 bytes":          long,
		"null":               `null`,
		"empty":              ``,
		"trailing object":    `{"v":1,"theme":"chime","waveform":"sine","pitch":0,"duration_ms":800}{}`,
		"array":              `[1]`,
	}
	for name, raw := range cases {
		if _, _, err := ValidateEntrancePreset([]byte(raw)); !errors.Is(err, ErrEntrancePresetInvalid) {
			t.Errorf("%s: err = %v, want ErrEntrancePresetInvalid", name, err)
		}
	}
}

func TestValidEntranceName(t *testing.T) {
	cases := map[string]bool{
		"Davul":                 true,
		"ş":                     true,
		strings.Repeat("a", 32): true,
		strings.Repeat("ğ", 32): true,
		strings.Repeat("a", 33): false,
		"":                      false,
		"evil‮eman":             false,
		"tab\tname":             false,
		"zero​width":            false,
	}
	for name, want := range cases {
		if got := ValidEntranceName(name); got != want {
			t.Errorf("ValidEntranceName(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestPutEntranceSelectionRequest_Validate(t *testing.T) {
	id := "0123456789abcdef"
	empty := ""
	cases := []struct {
		name string
		req  PutEntranceSelectionRequest
		want error
	}{
		{"global clip", PutEntranceSelectionRequest{Scope: "global", Kind: "clip", SoundID: &id}, nil},
		{"server preset", PutEntranceSelectionRequest{Scope: "srv1", Kind: "preset", Preset: []byte(`{}`)}, nil},
		{"none", PutEntranceSelectionRequest{Scope: "global", Kind: "none"}, nil},
		{"empty scope", PutEntranceSelectionRequest{Scope: " ", Kind: "none"}, ErrEntranceScopeInvalid},
		{"bad kind", PutEntranceSelectionRequest{Scope: "global", Kind: "loud"}, ErrEntranceScopeInvalid},
		{"clip without id", PutEntranceSelectionRequest{Scope: "global", Kind: "clip"}, ErrEntranceScopeInvalid},
		{"clip empty id", PutEntranceSelectionRequest{Scope: "global", Kind: "clip", SoundID: &empty}, ErrEntranceScopeInvalid},
		{"preset without body", PutEntranceSelectionRequest{Scope: "global", Kind: "preset"}, ErrEntrancePresetInvalid},
		{"steering scope", PutEntranceSelectionRequest{Scope: "srv‮1", Kind: "none"}, ErrEntranceScopeInvalid},
	}
	for _, c := range cases {
		err := c.req.Validate()
		if c.want == nil && err != nil {
			t.Errorf("%s: unexpected error %v", c.name, err)
		}
		if c.want != nil && !errors.Is(err, c.want) {
			t.Errorf("%s: err = %v, want %v", c.name, err, c.want)
		}
	}
}

func TestPatchServerEntranceSettingsRequest_Validate(t *testing.T) {
	ms := func(v int) *int { return &v }
	on := true
	cases := []struct {
		name string
		req  PatchServerEntranceSettingsRequest
		ok   bool
	}{
		{"empty", PatchServerEntranceSettingsRequest{}, false},
		{"enabled only", PatchServerEntranceSettingsRequest{Enabled: &on}, true},
		{"500", PatchServerEntranceSettingsRequest{MaxDurationMs: ms(500)}, true},
		{"5000", PatchServerEntranceSettingsRequest{MaxDurationMs: ms(5000)}, true},
		{"499", PatchServerEntranceSettingsRequest{MaxDurationMs: ms(499)}, false},
		{"5001", PatchServerEntranceSettingsRequest{MaxDurationMs: ms(5001)}, false},
	}
	for _, c := range cases {
		err := c.req.Validate()
		if c.ok != (err == nil) {
			t.Errorf("%s: err = %v, want ok=%v", c.name, err, c.ok)
		}
	}
}
