// Tests for the expression (custom emoji) image pipeline. Fixtures are
// small synthetic images built in-test; the hand-built "bomb" headers only
// ever go through ProcessExpressionImage, whose budgets run first.
package handlers

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"testing"
)

var pngMagic = []byte{0x89, 'P', 'N', 'G'}

func decodePNGBounds(t *testing.T, b []byte) image.Rectangle {
	t.Helper()
	if !bytes.HasPrefix(b, pngMagic) {
		t.Fatalf("static output is not a PNG (first bytes %x)", b[:min(len(b), 8)])
	}
	img, err := png.Decode(bytes.NewReader(b))
	if err != nil {
		t.Fatalf("decode static output: %v", err)
	}
	return img.Bounds()
}

func TestProcessExpressionImage_LargePNGScaledToFit(t *testing.T) {
	src := encodePNGFixture(t, newSolidRGBA(1000, 1000, color.RGBA{0x20, 0x40, 0x60, 0xff}))
	out, err := ProcessExpressionImage(context.Background(), bytes.NewReader(src), ExpressionEmoji)
	if err != nil {
		t.Fatalf("ProcessExpressionImage: %v", err)
	}
	if out.Animated != nil {
		t.Error("static input produced an animated copy")
	}
	if b := decodePNGBounds(t, out.Static); b.Dx() != 128 || b.Dy() != 128 {
		t.Errorf("static bounds = %v, want 128x128", b)
	}
}

// TestProcessExpressionImage_RoundTripSmallPNG is the Seek(0) canary: a
// valid PNG below the cap must survive the header check + rewind + decode
// unchanged in size (no upscale).
func TestProcessExpressionImage_RoundTripSmallPNG(t *testing.T) {
	src := encodePNGFixture(t, newSolidRGBA(40, 20, color.RGBA{0xff, 0, 0, 0x80}))
	out, err := ProcessExpressionImage(context.Background(), bytes.NewReader(src), ExpressionEmoji)
	if err != nil {
		t.Fatalf("ProcessExpressionImage: %v", err)
	}
	if b := decodePNGBounds(t, out.Static); b.Dx() != 40 || b.Dy() != 20 {
		t.Errorf("static bounds = %v, want 40x20 (never upscaled)", b)
	}
}

func TestProcessExpressionImage_JPEGBecomesPNG(t *testing.T) {
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, newSolidRGBA(300, 150, color.RGBA{0x10, 0x80, 0x10, 0xff}), nil); err != nil {
		t.Fatalf("encode jpeg fixture: %v", err)
	}
	out, err := ProcessExpressionImage(context.Background(), bytes.NewReader(buf.Bytes()), ExpressionEmoji)
	if err != nil {
		t.Fatalf("ProcessExpressionImage: %v", err)
	}
	if b := decodePNGBounds(t, out.Static); b.Dx() != 128 || b.Dy() != 64 {
		t.Errorf("static bounds = %v, want 128x64", b)
	}
}

// TestProcessExpressionImage_AnimatedFitNotCrop — a 200×100 two-frame GIF
// keeps its 2:1 aspect (128×64), unlike the avatar branch's square crop.
func TestProcessExpressionImage_AnimatedFitNotCrop(t *testing.T) {
	src := buildTestGIF(t, 2, 200, 100, true, []int{7, 9}, 0)
	out, err := ProcessExpressionImage(context.Background(), bytes.NewReader(src), ExpressionEmoji)
	if err != nil {
		t.Fatalf("ProcessExpressionImage: %v", err)
	}
	if out.Animated == nil {
		t.Fatal("multi-frame GIF produced no animated copy")
	}
	g, err := gif.DecodeAll(bytes.NewReader(out.Animated))
	if err != nil {
		t.Fatalf("decode animated output: %v", err)
	}
	if len(g.Image) != 2 {
		t.Fatalf("animated frames = %d, want 2", len(g.Image))
	}
	if g.Config.Width != 128 || g.Config.Height != 64 {
		t.Errorf("animated size = %dx%d, want 128x64 (fit, no crop)", g.Config.Width, g.Config.Height)
	}
	if g.Delay[0] != 7 || g.Delay[1] != 9 {
		t.Errorf("delays = %v, want [7 9]", g.Delay)
	}
	if b := decodePNGBounds(t, out.Static); b.Dx() != 128 || b.Dy() != 64 {
		t.Errorf("poster bounds = %v, want 128x64", b)
	}
}

// TestProcessExpressionImage_RejectsUnregisteredFormat — K-021 pin: BMP has
// no registered decoder, so it must fail on format, not be passed through.
func TestProcessExpressionImage_RejectsUnregisteredFormat(t *testing.T) {
	bmp := append([]byte("BM"), make([]byte, 52)...)
	_, err := ProcessExpressionImage(context.Background(), bytes.NewReader(bmp), ExpressionEmoji)
	if err == nil {
		t.Fatal("BMP accepted")
	}
	if errors.Is(err, ErrImageTooLarge) {
		t.Fatal("BMP should fail on unknown format, not the pixel guard")
	}
}

func TestProcessExpressionImage_RejectsDecodeBomb(t *testing.T) {
	_, err := ProcessExpressionImage(context.Background(), bytes.NewReader(buildTruncatedPNGBomb(30000, 30000)), ExpressionEmoji)
	if !errors.Is(err, ErrImageTooLarge) {
		t.Fatalf("err = %v, want ErrImageTooLarge", err)
	}
}

// TestProcessExpressionImage_StaticPixelCeiling — 2001×2000 (just over
// 4 MP) is refused from the header; the avatar ceiling (25 MP) would have
// let it through.
func TestProcessExpressionImage_StaticPixelCeiling(t *testing.T) {
	_, err := ProcessExpressionImage(context.Background(), bytes.NewReader(buildTruncatedPNGBomb(2001, 2000)), ExpressionEmoji)
	if !errors.Is(err, ErrImageTooLarge) {
		t.Fatalf("err = %v, want ErrImageTooLarge", err)
	}
}

func TestProcessExpressionImage_TooManyFrames(t *testing.T) {
	holdAnimatedSlot(t) // reaching DecodeAll would surface as ErrImageBusy
	src := buildRawGIF(4, 4, repeatFrames(maxAnimatedFrames+1, gifFrame{0, 0, 4, 4}), false)
	_, err := ProcessExpressionImage(shortCtx(t), bytes.NewReader(src), ExpressionEmoji)
	if !errors.Is(err, ErrTooManyFrames) {
		t.Fatalf("err = %v, want ErrTooManyFrames", err)
	}
}

func TestProcessExpressionImage_HugeAnimatedScreenRejected(t *testing.T) {
	holdAnimatedSlot(t)
	src := buildRawGIF(30000, 30000, repeatFrames(2, gifFrame{0, 0, 1, 1}), false)
	_, err := ProcessExpressionImage(shortCtx(t), bytes.NewReader(src), ExpressionEmoji)
	if !errors.Is(err, ErrImageTooLarge) {
		t.Fatalf("err = %v, want ErrImageTooLarge", err)
	}
}

func TestProcessExpressionImage_RejectsAnimatedWebP(t *testing.T) {
	_, err := ProcessExpressionImage(context.Background(), bytes.NewReader(animatedWebPHeader(0x02)), ExpressionEmoji)
	if !errors.Is(err, ErrAnimatedWebPUnsupported) {
		t.Fatalf("err = %v, want ErrAnimatedWebPUnsupported", err)
	}
}

// insertPNGChunk returns src with a chunk of the given type and data
// inserted right after IHDR (offset 33: 8-byte signature + 25-byte IHDR).
func insertPNGChunk(src []byte, typ string, data []byte) []byte {
	var chunk bytes.Buffer
	_ = binary.Write(&chunk, binary.BigEndian, uint32(len(data)))
	chunk.WriteString(typ)
	chunk.Write(data)
	_ = binary.Write(&chunk, binary.BigEndian, crc32.ChecksumIEEE(append([]byte(typ), data...)))
	out := append([]byte{}, src[:33]...)
	out = append(out, chunk.Bytes()...)
	return append(out, src[33:]...)
}

// TestProcessExpressionImage_APNGIsStatic — an APNG (acTL chunk present)
// takes the static path: image/png decodes only the default image.
func TestProcessExpressionImage_APNGIsStatic(t *testing.T) {
	base := encodePNGFixture(t, newSolidRGBA(64, 64, color.RGBA{0, 0, 0xff, 0xff}))
	actl := make([]byte, 8)
	binary.BigEndian.PutUint32(actl[0:4], 2) // num_frames
	apng := insertPNGChunk(base, "acTL", actl)

	out, err := ProcessExpressionImage(context.Background(), bytes.NewReader(apng), ExpressionEmoji)
	if err != nil {
		t.Fatalf("ProcessExpressionImage(APNG): %v", err)
	}
	if out.Animated != nil {
		t.Error("APNG produced an animated copy")
	}
	if b := decodePNGBounds(t, out.Static); b.Dx() != 64 {
		t.Errorf("static bounds = %v, want 64x64", b)
	}
}

func TestProcessExpressionImage_AnimatedOutputCap(t *testing.T) {
	small := ExpressionEmoji
	small.MaxAnimatedOutput = 64
	src := buildTestGIF(t, 3, 120, 120, false, nil, 0)
	_, err := ProcessExpressionImage(context.Background(), bytes.NewReader(src), small)
	if !errors.Is(err, ErrAnimatedTooLarge) {
		t.Fatalf("err = %v, want ErrAnimatedTooLarge", err)
	}
}
