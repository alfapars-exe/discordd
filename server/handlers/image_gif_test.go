// Tests for the animated-avatar branch (image_gif.go).
//
// SAFETY RULE (same as image_resize_test.go): the hand-built "bomb" GIF
// headers below must never be handed to gif.DecodeAll / image.Decode
// directly — they only ever go through ScanGIF / ProcessAvatar, whose
// budgets run first.
package handlers

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"image"
	"image/color"
	"image/gif"
	"image/png"
	"testing"
	"time"
)

// gifPalette is a small fixture palette; index 0 is transparent the way
// image/gif's decoder represents a transparent index.
var gifPalette = color.Palette{
	color.RGBA{},
	color.RGBA{0xff, 0x00, 0x00, 0xff},
	color.RGBA{0x00, 0xff, 0x00, 0xff},
	color.RGBA{0x00, 0x00, 0xff, 0xff},
}

// buildTestGIF encodes an n-frame w×h GIF with gif.EncodeAll. Frame i is
// filled with palette colour 1+i%3; when transparent is set, the left
// quarter of every frame uses the transparent index 0.
func buildTestGIF(t *testing.T, n, w, h int, transparent bool, delays []int, loop int) []byte {
	t.Helper()
	g := &gif.GIF{LoopCount: loop}
	for i := 0; i < n; i++ {
		f := image.NewPaletted(image.Rect(0, 0, w, h), gifPalette)
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				idx := uint8(1 + i%3)
				if transparent && x < w/4 {
					idx = 0
				}
				f.SetColorIndex(x, y, idx)
			}
		}
		g.Image = append(g.Image, f)
		d := 10
		if i < len(delays) {
			d = delays[i]
		}
		g.Delay = append(g.Delay, d)
	}
	var buf bytes.Buffer
	if err := gif.EncodeAll(&buf, g); err != nil {
		t.Fatalf("encode fixture gif: %v", err)
	}
	return buf.Bytes()
}

// gifFrame describes one hand-built image descriptor.
type gifFrame struct{ left, top, w, h uint16 }

// buildRawGIF hand-assembles a GIF: header + logical screen descriptor
// with a 2-entry global colour table (image/gif, and therefore ScanGIF,
// rejects frames with no colour table at all) + one image descriptor per
// frame, each with a one-byte data sub-block (never decoded — ScanGIF does
// not decompress), then the trailer unless omitTrailer is set. A few dozen
// bytes can declare any screen size and frame count.
func buildRawGIF(screenW, screenH uint16, frames []gifFrame, omitTrailer bool) []byte {
	var buf bytes.Buffer
	buf.WriteString("GIF89a")
	_ = binary.Write(&buf, binary.LittleEndian, screenW)
	_ = binary.Write(&buf, binary.LittleEndian, screenH)
	buf.Write([]byte{0x80, 0x00, 0x00})          // packed (2-entry GCT), bg index, aspect
	buf.Write([]byte{0, 0, 0, 0xff, 0xff, 0xff}) // global colour table
	for _, f := range frames {
		buf.WriteByte(0x2C)
		_ = binary.Write(&buf, binary.LittleEndian, []uint16{f.left, f.top, f.w, f.h})
		buf.WriteByte(0x00)           // packed: no local colour table
		buf.WriteByte(0x02)           // LZW minimum code size
		buf.Write([]byte{0x01, 0x00}) // one 1-byte data sub-block
		buf.WriteByte(0x00)           // sub-block terminator
	}
	if !omitTrailer {
		buf.WriteByte(0x3B)
	}
	return buf.Bytes()
}

func repeatFrames(n int, f gifFrame) []gifFrame {
	out := make([]gifFrame, n)
	for i := range out {
		out[i] = f
	}
	return out
}

// animatedWebPHeader is a RIFF/WEBP container whose VP8X chunk sets the
// Animation flag (0x02) — enough for IsAnimatedWebP and the upload reject.
func animatedWebPHeader(flags byte) []byte {
	var buf bytes.Buffer
	buf.WriteString("RIFF")
	_ = binary.Write(&buf, binary.LittleEndian, uint32(30))
	buf.WriteString("WEBP")
	buf.WriteString("VP8X")
	_ = binary.Write(&buf, binary.LittleEndian, uint32(10))
	buf.WriteByte(flags)
	buf.Write([]byte{0, 0, 0})    // reserved
	buf.Write([]byte{0x3F, 0, 0}) // canvas width - 1 (64)
	buf.Write([]byte{0x3F, 0, 0}) // canvas height - 1 (64)
	buf.WriteString("ANIM")
	_ = binary.Write(&buf, binary.LittleEndian, uint32(6))
	buf.Write(make([]byte, 6))
	return buf.Bytes()
}

// holdAnimatedSlot occupies the single animated-processing slot until the
// test ends, so any input that reaches the slot acquisition fails with
// ErrImageBusy instead of decoding.
func holdAnimatedSlot(t *testing.T) {
	t.Helper()
	animatedSlots <- struct{}{}
	t.Cleanup(func() { <-animatedSlots })
}

func shortCtx(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	t.Cleanup(cancel)
	return ctx
}

// TestScanGIF_HugeScreenRejectedBeforeDecode — a ~40-byte GIF declaring a
// 30000×30000 logical screen. The slot is held, so if the input reached the
// slot (and with it gif.DecodeAll) the error would be ErrImageBusy; getting
// ErrImageTooLarge proves the header-only budget check rejected it first.
func TestScanGIF_HugeScreenRejectedBeforeDecode(t *testing.T) {
	two := buildRawGIF(30000, 30000, repeatFrames(2, gifFrame{0, 0, 1, 1}), false)
	frames, w, h, err := ScanGIF(bytes.NewReader(two), maxAnimatedFrames)
	if err != nil || frames != 2 || w != 30000 || h != 30000 {
		t.Fatalf("ScanGIF = %d, %dx%d, %v; want 2, 30000x30000, nil", frames, w, h, err)
	}

	holdAnimatedSlot(t)
	for name, src := range map[string][]byte{
		"animated (2 frames)": two,
		"static (1 frame)":    buildRawGIF(30000, 30000, []gifFrame{{0, 0, 1, 1}}, false),
	} {
		_, err := ProcessAvatar(shortCtx(t), bytes.NewReader(src))
		if !errors.Is(err, ErrImageTooLarge) || errors.Is(err, ErrImageBusy) {
			t.Errorf("%s: err = %v, want ErrImageTooLarge (not busy)", name, err)
		}
	}
}

func TestScanGIF_TooManyFrames(t *testing.T) {
	src := buildRawGIF(8, 8, repeatFrames(maxAnimatedFrames+1, gifFrame{0, 0, 8, 8}), false)
	if _, _, _, err := ScanGIF(bytes.NewReader(src), maxAnimatedFrames); !errors.Is(err, ErrTooManyFrames) {
		t.Fatalf("ScanGIF err = %v, want ErrTooManyFrames", err)
	}
	if _, err := ProcessAvatar(context.Background(), bytes.NewReader(src)); !errors.Is(err, ErrTooManyFrames) {
		t.Fatalf("ProcessAvatar err = %v, want ErrTooManyFrames", err)
	}

	// Exactly the cap is fine at the scan level.
	atCap := buildRawGIF(8, 8, repeatFrames(maxAnimatedFrames, gifFrame{0, 0, 8, 8}), false)
	if n, _, _, err := ScanGIF(bytes.NewReader(atCap), maxAnimatedFrames); err != nil || n != maxAnimatedFrames {
		t.Fatalf("ScanGIF(at cap) = %d, %v", n, err)
	}
}

// TestProcessAvatar_TotalPixelBudget — 100 frames × 700×700 = 49 M pixels:
// each frame and the screen are within budget, the total is not.
func TestProcessAvatar_TotalPixelBudget(t *testing.T) {
	src := buildRawGIF(700, 700, repeatFrames(100, gifFrame{0, 0, 1, 1}), false)
	holdAnimatedSlot(t)
	_, err := ProcessAvatar(shortCtx(t), bytes.NewReader(src))
	if !errors.Is(err, ErrImageTooLarge) || errors.Is(err, ErrImageBusy) {
		t.Fatalf("err = %v, want ErrImageTooLarge from the total budget", err)
	}
}

func TestScanGIF_MalformedInputs(t *testing.T) {
	cases := map[string][]byte{
		"frame outside screen": buildRawGIF(10, 10, []gifFrame{{5, 0, 10, 10}}, false),
		"missing trailer":      buildRawGIF(10, 10, []gifFrame{{0, 0, 10, 10}}, true),
		"no frames":            buildRawGIF(10, 10, nil, false),
		"unknown block": append(buildRawGIF(10, 10, []gifFrame{{0, 0, 10, 10}}, true),
			0x99),
		"truncated sub-block": append(buildRawGIF(10, 10, nil, true),
			0x2C, 0, 0, 0, 0, 10, 0, 10, 0, 0, 0x02, 0x40, 0x01),
		"not a gif": []byte("PNG not really a gif at all"),
	}
	for name, src := range cases {
		if _, _, _, err := ScanGIF(bytes.NewReader(src), maxAnimatedFrames); err == nil {
			t.Errorf("%s: ScanGIF accepted malformed input", name)
		}
	}
}

func TestIsAnimatedWebP(t *testing.T) {
	if !IsAnimatedWebP(animatedWebPHeader(0x02)) {
		t.Error("VP8X with the animation flag not detected")
	}
	if IsAnimatedWebP(animatedWebPHeader(0x10)) { // alpha only
		t.Error("still VP8X (no animation flag) reported as animated")
	}
	if IsAnimatedWebP([]byte("RIFF")) {
		t.Error("short input reported as animated")
	}
	_, err := ProcessAvatar(context.Background(), bytes.NewReader(animatedWebPHeader(0x12)))
	if !errors.Is(err, ErrAnimatedWebPUnsupported) {
		t.Fatalf("ProcessAvatar err = %v, want ErrAnimatedWebPUnsupported", err)
	}
}

func TestProcessAvatar_SingleFrameGIFTakesStaticPath(t *testing.T) {
	src := buildTestGIF(t, 1, 300, 200, false, nil, 0)
	res, err := ProcessAvatar(context.Background(), bytes.NewReader(src))
	if err != nil {
		t.Fatalf("ProcessAvatar: %v", err)
	}
	if res.Animated != nil {
		t.Fatal("single-frame GIF produced an animated copy")
	}
	img, _, err := image.Decode(bytes.NewReader(res.Static))
	if err != nil {
		t.Fatalf("decode static: %v", err)
	}
	// Static path keeps the aspect ratio (no crop) and caps at 256.
	if b := img.Bounds(); b.Dx() != avatarMaxDim || b.Dy() != 171 {
		t.Errorf("static dims = %v, want 256x171", b)
	}
}

func TestProcessAvatar_AnimatedRoundTrip(t *testing.T) {
	delays := []int{5, 10, 15}
	src := buildTestGIF(t, 3, 200, 160, true, delays, 2)
	res, err := ProcessAvatar(context.Background(), bytes.NewReader(src))
	if err != nil {
		t.Fatalf("ProcessAvatar: %v", err)
	}
	if res.Animated == nil {
		t.Fatal("3-frame GIF produced no animated copy")
	}

	out, err := gif.DecodeAll(bytes.NewReader(res.Animated))
	if err != nil {
		t.Fatalf("decode animated output: %v", err)
	}
	if len(out.Image) != 3 {
		t.Fatalf("frames = %d, want 3", len(out.Image))
	}
	if out.LoopCount != 2 {
		t.Errorf("LoopCount = %d, want 2", out.LoopCount)
	}
	for i, f := range out.Image {
		if b := f.Bounds(); b.Dx() != animatedAvatarDim || b.Dy() != animatedAvatarDim {
			t.Errorf("frame %d bounds = %v, want %dx%d", i, b, animatedAvatarDim, animatedAvatarDim)
		}
		if out.Delay[i] != delays[i] {
			t.Errorf("frame %d delay = %d, want %d", i, out.Delay[i], delays[i])
		}
		if out.Disposal[i] != gif.DisposalBackground {
			t.Errorf("frame %d disposal = %d, want DisposalBackground", i, out.Disposal[i])
		}
		// Centre-crop of 200x160 keeps x in [20,180); the source's
		// transparent band is x < 50, i.e. output x < (50-20)*128/160 = 24.
		if _, _, _, a := f.At(4, 64).RGBA(); a != 0 {
			t.Errorf("frame %d: pixel in the transparent band has alpha %d", i, a)
		}
		if _, _, _, a := f.At(100, 64).RGBA(); a != 0xffff {
			t.Errorf("frame %d: opaque pixel has alpha %d", i, a)
		}
	}

	poster, err := png.Decode(bytes.NewReader(res.Static))
	if err != nil {
		t.Fatalf("poster is not a PNG (transparent source): %v", err)
	}
	if b := poster.Bounds(); b.Dx() != 160 || b.Dy() != 160 {
		t.Errorf("poster dims = %v, want 160x160 (square crop, no upscale)", b)
	}
	if res.StaticExt != ".png" {
		t.Errorf("poster ext = %q, want .png", res.StaticExt)
	}
}

func TestProcessAvatar_CanceledContext(t *testing.T) {
	src := buildTestGIF(t, 2, 32, 32, false, nil, 0)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := ProcessAvatar(ctx, bytes.NewReader(src))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
}

func TestProcessAvatar_BusySlot(t *testing.T) {
	src := buildTestGIF(t, 2, 32, 32, false, nil, 0)
	holdAnimatedSlot(t)
	_, err := ProcessAvatar(shortCtx(t), bytes.NewReader(src))
	if !errors.Is(err, ErrImageBusy) {
		t.Fatalf("err = %v, want ErrImageBusy", err)
	}
}
