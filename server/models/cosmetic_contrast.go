// Package models - cosmetic_contrast.go: WCAG 2.x contrast for name styles.
//
// Mirrors client/src/utils/cosmeticContrast.ts exactly (same names, same
// sampling), so a name style the server accepts is one the client renders.
package models

import (
	"math"
	"strconv"
)

// nameStyleSamples is how many evenly spaced samples (t = k/8, k = 0..8)
// a two-stop name style is checked at - the midpoints catch the luminance
// dip of an sRGB gradient between two light stops.
const nameStyleSamples = 8

// parseHex reads "#rrggbb" (either case). ok is false for anything else.
func parseHex(s string) (r, g, b uint8, ok bool) {
	if !cosmeticHexPattern.MatchString(s) {
		return 0, 0, 0, false
	}
	v, err := strconv.ParseUint(s[1:], 16, 32)
	if err != nil {
		return 0, 0, 0, false
	}
	return uint8(v >> 16), uint8(v >> 8), uint8(v), true
}

func channelLinear(c uint8) float64 {
	x := float64(c) / 255
	if x <= 0.04045 {
		return x / 12.92
	}
	return math.Pow((x+0.055)/1.055, 2.4)
}

func relativeLuminance(r, g, b uint8) float64 {
	return 0.2126*channelLinear(r) + 0.7152*channelLinear(g) + 0.0722*channelLinear(b)
}

func contrastOfLuminances(la, lb float64) float64 {
	hi, lo := math.Max(la, lb), math.Min(la, lb)
	return (hi + 0.05) / (lo + 0.05)
}

// ContrastRatio returns the WCAG 2.x contrast ratio of two "#rrggbb"
// colors (1..21), or 0 when either is malformed.
func ContrastRatio(a, b string) float64 {
	ar, ag, ab, ok := parseHex(a)
	if !ok {
		return 0
	}
	br, bg, bb, ok := parseHex(b)
	if !ok {
		return 0
	}
	return contrastOfLuminances(relativeLuminance(ar, ag, ab), relativeLuminance(br, bg, bb))
}

// NameStyleReadable reports whether a name style with these stops (1 or 2)
// keeps a contrast of at least CosmeticContrastMin against
// CosmeticContrastReference at every sample: the single color, or for two
// stops t = 0, 1/8, ..., 1 with each sRGB channel interpolated linearly
// and rounded to the nearest integer.
func NameStyleReadable(stops []string) bool {
	rr, rg, rb, _ := parseHex(CosmeticContrastReference)
	refLum := relativeLuminance(rr, rg, rb)

	switch len(stops) {
	case 1:
		r, g, b, ok := parseHex(stops[0])
		return ok && contrastOfLuminances(relativeLuminance(r, g, b), refLum) >= CosmeticContrastMin
	case 2:
		ar, ag, ab, ok := parseHex(stops[0])
		if !ok {
			return false
		}
		br, bg, bb, ok := parseHex(stops[1])
		if !ok {
			return false
		}
		for k := 0; k <= nameStyleSamples; k++ {
			t := float64(k) / nameStyleSamples
			r, g, b := lerpChannel(ar, br, t), lerpChannel(ag, bg, t), lerpChannel(ab, bb, t)
			if contrastOfLuminances(relativeLuminance(r, g, b), refLum) < CosmeticContrastMin {
				return false
			}
		}
		return true
	}
	return false
}

// lerpChannel is round(a + (b-a)*t). math.Round rounds half away from zero,
// which equals JS Math.round for the non-negative values here.
func lerpChannel(a, b uint8, t float64) uint8 {
	return uint8(math.Round(float64(a) + (float64(b)-float64(a))*t))
}
