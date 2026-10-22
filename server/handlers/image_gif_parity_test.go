package handlers

// Parser-parity tests for ScanGIF. ScanGIF is the allocation-free pre-check
// that bounds what gif.DecodeAll may decode, so it must read the GIF block
// grammar exactly like image/gif does: whenever the stdlib decoder accepts
// an input, ScanGIF must accept it too and count the same frames.

import (
	"bytes"
	"errors"
	"image/gif"
	"testing"
)

// gifBodyStart returns the offset just past the header, logical screen
// descriptor and (if present) global colour table — where the first block
// (extension or image descriptor) begins.
func gifBodyStart(t *testing.T, b []byte) int {
	t.Helper()
	if len(b) < 13 {
		t.Fatalf("fixture too short")
	}
	off := 13
	if b[10]&0x80 != 0 {
		off += colorTableSize(b[10])
	}
	return off
}

// spliceAfterHeader inserts block right after the header/global colour
// table of an encoded GIF.
func spliceAfterHeader(t *testing.T, b, block []byte) []byte {
	t.Helper()
	off := gifBodyStart(t, b)
	out := make([]byte, 0, len(b)+len(block))
	out = append(out, b[:off]...)
	out = append(out, block...)
	return append(out, b[off:]...)
}

// plainTextExt builds a Plain Text extension whose fixed 13-byte header
// begins with headerFirst, followed by an empty sub-block chain. A header
// byte other than 12 is not valid per the spec, but image/gif skips the 13
// bytes regardless — which is exactly where a generic "label + sub-blocks"
// walk used to diverge.
func plainTextExt(headerFirst byte) []byte {
	ext := []byte{0x21, 0x01, headerFirst}
	ext = append(ext, make([]byte, 12)...)
	return append(ext, 0x00)
}

// assertParity checks the invariant against the stdlib decoder.
func assertParity(t *testing.T, name string, b []byte) {
	t.Helper()
	g, decErr := gif.DecodeAll(bytes.NewReader(b))
	frames, _, _, scanErr := ScanGIF(bytes.NewReader(b), 1<<20)
	if decErr == nil {
		if scanErr != nil {
			t.Fatalf("%s: stdlib decoded %d frames but ScanGIF failed: %v", name, len(g.Image), scanErr)
		}
		if frames != len(g.Image) {
			t.Fatalf("%s: ScanGIF counted %d frames, stdlib decoded %d", name, frames, len(g.Image))
		}
	}
}

func TestScanGIF_PlainTextExtensionDoesNotHideFrames(t *testing.T) {
	base := buildTestGIF(t, 5, 1, 1, false, nil, 0)
	blob := spliceAfterHeader(t, base, plainTextExt(0xFF))

	g, err := gif.DecodeAll(bytes.NewReader(blob))
	if err != nil {
		t.Fatalf("stdlib must accept the fixture: %v", err)
	}
	if len(g.Image) != 5 {
		t.Fatalf("fixture: stdlib decoded %d frames, want 5", len(g.Image))
	}

	frames, _, _, err := ScanGIF(bytes.NewReader(blob), maxAnimatedFrames)
	if err != nil {
		t.Fatalf("ScanGIF: %v", err)
	}
	if frames != 5 {
		t.Fatalf("ScanGIF counted %d frames, want 5 (frames must not be hidden by the extension)", frames)
	}

	// With a cap below the real count the scan must stop the input.
	if _, _, _, err := ScanGIF(bytes.NewReader(blob), 3); !errors.Is(err, ErrTooManyFrames) {
		t.Fatalf("ScanGIF with cap 3: err = %v, want ErrTooManyFrames", err)
	}
}

func TestScanGIF_MatchesStdlibOnExtensions(t *testing.T) {
	base := buildTestGIF(t, 3, 4, 4, true, []int{5, 6, 7}, 2)

	cases := map[string][]byte{
		"encoder output":              base,
		"plain text ext, valid size":  spliceAfterHeader(t, base, plainTextExt(12)),
		"plain text ext, bad size":    spliceAfterHeader(t, base, plainTextExt(0xFF)),
		"plain text ext, zero size":   spliceAfterHeader(t, base, plainTextExt(0x00)),
		"comment ext":                 spliceAfterHeader(t, base, []byte{0x21, 0xFE, 0x03, 'a', 'b', 'c', 0x00}),
		"application ext, size 11":    spliceAfterHeader(t, base, append([]byte{0x21, 0xFF, 0x0B}, append([]byte("XMP DataXMP"), 0x02, 'x', 'y', 0x00)...)),
		"application ext, size 10":    spliceAfterHeader(t, base, append([]byte{0x21, 0xFF, 0x0A}, append([]byte("ADOBE10abc"), 0x00)...)),
		"unknown extension label":     spliceAfterHeader(t, base, []byte{0x21, 0x02, 0x00}),
		"graphic control, bad size":   spliceAfterHeader(t, base, []byte{0x21, 0xF9, 0x05, 0, 0, 0, 0, 0, 0}),
		"graphic control, no term":    spliceAfterHeader(t, base, []byte{0x21, 0xF9, 0x04, 0, 0, 0, 0, 0x07}),
		"trailing junk after trailer": append(append([]byte{}, base...), 0xDE, 0xAD),
		"truncated":                   base[:len(base)-3],
	}
	for name, b := range cases {
		t.Run(name, func(t *testing.T) { assertParity(t, name, b) })
	}
}

func TestProcessAvatar_RejectsDecoderScanMismatch(t *testing.T) {
	// The post-decode check is defence in depth: feed processAnimatedGIF a
	// scan count that disagrees with what DecodeAll will see.
	blob := buildTestGIF(t, 4, 8, 8, false, nil, 0)
	_, err := processAnimatedGIF(shortCtx(t), bytes.NewReader(blob), 2, 8, 8)
	if !errors.Is(err, ErrTooManyFrames) {
		t.Fatalf("err = %v, want ErrTooManyFrames on scan/decoder mismatch", err)
	}
}

// FuzzScanGIFMatchesStdlib asserts the parity invariant on arbitrary input.
// `go test` runs only the seed corpus; run `go test -fuzz=FuzzScanGIF` to
// explore further.
func FuzzScanGIFMatchesStdlib(f *testing.F) {
	f.Add(buildRawGIF(4, 4, repeatFrames(3, gifFrame{0, 0, 4, 4}), false))
	f.Add([]byte("GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff\x21\x01\xff" +
		"\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x3b"))
	f.Fuzz(func(t *testing.T, b []byte) {
		// Keep fuzz iterations cheap: skip inputs whose declared screen
		// would make the stdlib decoder allocate large buffers.
		cfg, err := gif.DecodeConfig(bytes.NewReader(b))
		if err != nil || cfg.Width*cfg.Height > 1<<16 {
			return
		}
		assertParity(t, "fuzz", b)
	})
}
