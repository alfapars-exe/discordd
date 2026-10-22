// Boundary and budget regression tests for the ExpressionSticker profile on
// the unchanged ProcessExpressionImage pipeline. Fixtures are small
// synthetic images built in-test (helpers from image_expression_test.go /
// image_gif_test.go / image_resize_test.go); hand-built headers only ever go
// through ProcessExpressionImage, whose budgets run first.
package handlers

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"image/color"
	"image/gif"
	"testing"
)

func TestStickerProfile_StaticFitsTo320(t *testing.T) {
	src := encodePNGFixture(t, newSolidRGBA(640, 320, color.RGBA{0x20, 0x40, 0x60, 0xff}))
	out, err := ProcessExpressionImage(context.Background(), bytes.NewReader(src), ExpressionSticker)
	if err != nil {
		t.Fatalf("ProcessExpressionImage: %v", err)
	}
	if out.Animated != nil {
		t.Error("static input produced an animated copy")
	}
	if b := decodePNGBounds(t, out.Static); b.Dx() != 320 || b.Dy() != 160 {
		t.Errorf("static bounds = %v, want 320x160 (fit, aspect kept)", b)
	}
}

func TestStickerProfile_NeverUpscales(t *testing.T) {
	src := encodePNGFixture(t, newSolidRGBA(100, 50, color.RGBA{0xff, 0, 0, 0xff}))
	out, err := ProcessExpressionImage(context.Background(), bytes.NewReader(src), ExpressionSticker)
	if err != nil {
		t.Fatalf("ProcessExpressionImage: %v", err)
	}
	if b := decodePNGBounds(t, out.Static); b.Dx() != 100 || b.Dy() != 50 {
		t.Errorf("static bounds = %v, want 100x50 (never upscaled)", b)
	}
}

func TestStickerProfile_AnimatedFitsTo320WithPoster(t *testing.T) {
	src := buildTestGIF(t, 2, 640, 320, false, []int{5, 8}, 0)
	out, err := ProcessExpressionImage(context.Background(), bytes.NewReader(src), ExpressionSticker)
	if err != nil {
		t.Fatalf("ProcessExpressionImage: %v", err)
	}
	if out.Animated == nil {
		t.Fatal("two-frame GIF produced no animated copy")
	}
	g, err := gif.DecodeAll(bytes.NewReader(out.Animated))
	if err != nil {
		t.Fatalf("decode animated output: %v", err)
	}
	if len(g.Image) != 2 || g.Config.Width != 320 || g.Config.Height != 160 {
		t.Errorf("animated = %d frames %dx%d, want 2 frames 320x160", len(g.Image), g.Config.Width, g.Config.Height)
	}
	if b := decodePNGBounds(t, out.Static); b.Dx() != 320 || b.Dy() != 160 {
		t.Errorf("poster bounds = %v, want 320x160", b)
	}
}

func TestStickerProfile_RejectsAnimatedWebP(t *testing.T) {
	_, err := ProcessExpressionImage(context.Background(), bytes.NewReader(animatedWebPHeader(0x02)), ExpressionSticker)
	if !errors.Is(err, ErrAnimatedWebPUnsupported) {
		t.Fatalf("err = %v, want ErrAnimatedWebPUnsupported", err)
	}
}

// TestStickerProfile_FrameCountBudget — one frame over maxAnimatedFrames is
// refused by the pre-scan, before any decode.
func TestStickerProfile_FrameCountBudget(t *testing.T) {
	holdAnimatedSlot(t) // reaching DecodeAll would surface as ErrImageBusy
	src := buildRawGIF(4, 4, repeatFrames(maxAnimatedFrames+1, gifFrame{0, 0, 4, 4}), false)
	_, err := ProcessExpressionImage(shortCtx(t), bytes.NewReader(src), ExpressionSticker)
	if !errors.Is(err, ErrTooManyFrames) {
		t.Fatalf("err = %v, want ErrTooManyFrames", err)
	}
}

// TestStickerProfile_AnimatedOutputCap — the output-size budget applies to
// the sticker profile (checked on a shrunken copy of the profile so the
// fixture stays tiny).
func TestStickerProfile_AnimatedOutputCap(t *testing.T) {
	if ExpressionSticker.MaxAnimatedOutput != 1<<20 || ExpressionSticker.Dim != 320 || ExpressionSticker.MaxDecodePixels != 4_000_000 {
		t.Fatalf("ExpressionSticker = %+v, want {320 4000000 1MiB}", ExpressionSticker)
	}
	small := ExpressionSticker
	small.MaxAnimatedOutput = 64
	src := buildTestGIF(t, 3, 120, 120, false, nil, 0)
	_, err := ProcessExpressionImage(context.Background(), bytes.NewReader(src), small)
	if !errors.Is(err, ErrAnimatedTooLarge) {
		t.Fatalf("err = %v, want ErrAnimatedTooLarge", err)
	}
}

func TestStickerProfile_APNGIsStaticOnly(t *testing.T) {
	base := encodePNGFixture(t, newSolidRGBA(64, 64, color.RGBA{0, 0, 0xff, 0xff}))
	actl := make([]byte, 8)
	binary.BigEndian.PutUint32(actl[0:4], 2) // num_frames
	apng := insertPNGChunk(base, "acTL", actl)

	out, err := ProcessExpressionImage(context.Background(), bytes.NewReader(apng), ExpressionSticker)
	if err != nil {
		t.Fatalf("ProcessExpressionImage(APNG): %v", err)
	}
	if out.Animated != nil {
		t.Error("APNG produced an animated copy")
	}
	if b := decodePNGBounds(t, out.Static); b.Dx() != 64 || b.Dy() != 64 {
		t.Errorf("static bounds = %v, want 64x64", b)
	}
}
