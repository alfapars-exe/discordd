package models

import (
	"math"
	"testing"
)

// Vectors shared verbatim with client/src/utils/cosmeticContrast.test.ts
// (contract section 4).
func TestContrastRatio_Vectors(t *testing.T) {
	cases := []struct {
		a, b string
		want float64
	}{
		{"#ffffff", "#3b4252", 10.06},
		{"#b0b0b0", "#3b4252", 4.64},
		{"#a0a0a0", "#3b4252", 3.85},
		{"#ffffff", "#000000", 21},
		{"#3b4252", "#3b4252", 1},
	}
	for _, c := range cases {
		if got := ContrastRatio(c.a, c.b); math.Abs(got-c.want) > 0.01 {
			t.Errorf("ContrastRatio(%s, %s) = %.4f, want %.2f", c.a, c.b, got, c.want)
		}
	}
	// Symmetric, case-insensitive, 0 for malformed input.
	if ContrastRatio("#3b4252", "#FFFFFF") != ContrastRatio("#ffffff", "#3b4252") {
		t.Error("ContrastRatio is not symmetric / case-insensitive")
	}
	for _, bad := range []string{"#fff", "red", "#12345g", ""} {
		if got := ContrastRatio(bad, "#000000"); got != 0 {
			t.Errorf("ContrastRatio(%q) = %v, want 0", bad, got)
		}
	}
}

func TestNameStyleReadable_Vectors(t *testing.T) {
	pass := [][]string{
		{"#ffffff"},
		{"#b0b0b0"},
		{"#ffd166", "#ffb703"},
		{"#a8e6ff", "#e0f7ff"},
		// every b_name_* seed of migration 089
		{"#ffd166", "#ffb703"},
		{"#a8e6ff", "#e0f7ff"},
		{"#ffb3c6", "#ffd6e0"},
		{"#b8f2d0", "#7ee0b0"},
		{"#d7b8ff", "#b8c6ff"},
		{"#b8ffb8"},
	}
	for _, stops := range pass {
		if !NameStyleReadable(stops) {
			t.Errorf("NameStyleReadable(%v) = false, want true", stops)
		}
	}
	fail := [][]string{
		{"#a0a0a0"},
		{"#808080"},
		{"#3b4252"},
		{"#ffffff", "#000000"}, // the intermediate samples fall below 4.5
		{},
		{"#ffffff", "#ffffff", "#ffffff"},
		{"#fff"},
	}
	for _, stops := range fail {
		if NameStyleReadable(stops) {
			t.Errorf("NameStyleReadable(%v) = true, want false", stops)
		}
	}
}

func TestLerpChannel_RoundsHalfUp(t *testing.T) {
	// 0 -> 255 at t = 1/2 is 127.5, rounded to 128 (JS Math.round agrees).
	if got := lerpChannel(0, 255, 0.5); got != 128 {
		t.Errorf("lerpChannel(0, 255, 0.5) = %d, want 128", got)
	}
	if got := lerpChannel(255, 0, 0.125); got != 223 {
		t.Errorf("lerpChannel(255, 0, 1/8) = %d, want 223", got)
	}
}
