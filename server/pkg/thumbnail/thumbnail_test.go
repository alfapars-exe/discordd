package thumbnail

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"testing"
)

// synth builds a solid-color RGBA source image at the requested
// dimensions — enough for the resize/encode path without any real
// on-disk fixture. Solid color also keeps the encoded JPEG small.
func synth(w, h int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	// A single non-transparent color: solid mid-grey.
	c := color.RGBA{R: 128, G: 128, B: 128, A: 255}
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, c)
		}
	}
	return img
}

func encodePNG(t *testing.T, img image.Image) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("test-fixture PNG encode failed: %v", err)
	}
	return buf.Bytes()
}

func encodeJPEG(t *testing.T, img image.Image) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatalf("test-fixture JPEG encode failed: %v", err)
	}
	return buf.Bytes()
}

func encodeGIF(t *testing.T, img image.Image) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := gif.Encode(&buf, img, nil); err != nil {
		t.Fatalf("test-fixture GIF encode failed: %v", err)
	}
	return buf.Bytes()
}

// decodeDim reads the output JPEG back so we can assert the resize
// actually happened. jpeg.Decode is the mirror of jpeg.Encode.
func decodeDim(t *testing.T, out []byte) (w, h int) {
	t.Helper()
	dec, err := jpeg.Decode(bytes.NewReader(out))
	if err != nil {
		t.Fatalf("output JPEG failed to decode: %v", err)
	}
	b := dec.Bounds()
	return b.Dx(), b.Dy()
}

func TestGenerate_downscalesLandscapeToMaxWidth(t *testing.T) {
	// 4000x2000 → MaxDimension=512 should give 512x256 (aspect preserved).
	// Common phone-camera-landscape shape after HEIC→JPEG on iOS.
	in := encodePNG(t, synth(4000, 2000))
	var out bytes.Buffer

	if err := Generate(&out, bytes.NewReader(in), Options{MaxDimension: 512}); err != nil {
		t.Fatalf("Generate: %v", err)
	}

	w, h := decodeDim(t, out.Bytes())
	if w != 512 || h != 256 {
		t.Errorf("dims = %dx%d, want 512x256", w, h)
	}
}

func TestGenerate_downscalesPortraitToMaxHeight(t *testing.T) {
	// Portrait: 2000x4000 → 256x512. Aspect ratio flipped, height wins.
	in := encodePNG(t, synth(2000, 4000))
	var out bytes.Buffer

	if err := Generate(&out, bytes.NewReader(in), Options{MaxDimension: 512}); err != nil {
		t.Fatalf("Generate: %v", err)
	}

	w, h := decodeDim(t, out.Bytes())
	if w != 256 || h != 512 {
		t.Errorf("dims = %dx%d, want 256x512", w, h)
	}
}

func TestGenerate_smallSourcePreservedNotUpscaled(t *testing.T) {
	// Source smaller than MaxDimension in BOTH axes → passthrough.
	// Upscaling would produce a blurry thumbnail that's larger on disk
	// than the source; the useful behavior is "leave it alone".
	in := encodePNG(t, synth(64, 32))
	var out bytes.Buffer

	if err := Generate(&out, bytes.NewReader(in), Options{MaxDimension: 512}); err != nil {
		t.Fatalf("Generate: %v", err)
	}

	w, h := decodeDim(t, out.Bytes())
	if w != 64 || h != 32 {
		t.Errorf("small source got resized: %dx%d, want 64x32", w, h)
	}
}

func TestGenerate_zeroOptsUsesDefaults(t *testing.T) {
	// Empty Options{} → DefaultMaxDimension (512), DefaultJPEGQuality (85).
	// Callers that don't care about tuning should not have to pass values.
	in := encodePNG(t, synth(1000, 1000))
	var out bytes.Buffer

	if err := Generate(&out, bytes.NewReader(in), Options{}); err != nil {
		t.Fatalf("Generate: %v", err)
	}

	w, h := decodeDim(t, out.Bytes())
	if w != DefaultMaxDimension || h != DefaultMaxDimension {
		t.Errorf("default dims = %dx%d, want %dx%[3]d",
			w, h, DefaultMaxDimension)
	}
}

func TestGenerate_clampsRunawayMaxDimension(t *testing.T) {
	// A misconfigured caller asking for MaxDimension=99999 must be
	// clamped to hardMaxDimension. Otherwise a single upload could pin
	// the encoder with a 100-megapixel resize.
	in := encodePNG(t, synth(3000, 3000))
	var out bytes.Buffer

	if err := Generate(&out, bytes.NewReader(in), Options{MaxDimension: 99999}); err != nil {
		t.Fatalf("Generate: %v", err)
	}

	w, h := decodeDim(t, out.Bytes())
	if w > hardMaxDimension || h > hardMaxDimension {
		t.Errorf("dims %dx%d exceed hardMaxDimension %d — caller clamp failed",
			w, h, hardMaxDimension)
	}
}

func TestGenerate_acceptsJPEGSource(t *testing.T) {
	in := encodeJPEG(t, synth(800, 600))
	var out bytes.Buffer
	if err := Generate(&out, bytes.NewReader(in), Options{MaxDimension: 400}); err != nil {
		t.Fatalf("Generate JPEG source: %v", err)
	}
	if out.Len() == 0 {
		t.Error("empty output from valid JPEG source")
	}
}

func TestGenerate_acceptsGIFSource(t *testing.T) {
	// GIF-source support matters because chat lets users share Klipy /
	// Giphy content — the first frame is a reasonable thumbnail.
	in := encodeGIF(t, synth(600, 800))
	var out bytes.Buffer
	if err := Generate(&out, bytes.NewReader(in), Options{MaxDimension: 400}); err != nil {
		t.Fatalf("Generate GIF source: %v", err)
	}
	if out.Len() == 0 {
		t.Error("empty output from valid GIF source")
	}
}

func TestGenerate_rejectsGarbageSource(t *testing.T) {
	garbage := []byte("this is not an image")
	var out bytes.Buffer

	err := Generate(&out, bytes.NewReader(garbage), Options{})
	if !errors.Is(err, ErrUnsupportedFormat) {
		t.Errorf("garbage input should return ErrUnsupportedFormat, got %v", err)
	}
	if out.Len() != 0 {
		t.Errorf("failed decode wrote %d bytes to dst — should have been zero", out.Len())
	}
}

func TestGenerate_rejectsEmptyInput(t *testing.T) {
	// Empty reader can't be a valid image; must not write anything to
	// dst so a caller that pipes to a file doesn't get a zero-byte
	// "success" it then tries to open.
	var out bytes.Buffer
	err := Generate(&out, bytes.NewReader(nil), Options{})
	if !errors.Is(err, ErrUnsupportedFormat) {
		t.Errorf("empty input should return ErrUnsupportedFormat, got %v", err)
	}
	if out.Len() != 0 {
		t.Errorf("empty input wrote %d bytes to dst", out.Len())
	}
}

func TestScaleTo_pinsAspectRatioBoundaries(t *testing.T) {
	cases := []struct {
		name       string
		srcW, srcH int
		maxDim     int
		wantW      int
		wantH      int
	}{
		{"square exactly at cap → passthrough", 512, 512, 512, 512, 512},
		{"landscape at exact 2:1", 1000, 500, 500, 500, 250},
		{"portrait at exact 1:2", 500, 1000, 500, 250, 500},
		{"very wide → height rounds to 1, not 0", 10000, 3, 500, 500, 1},
		{"tiny source stays passthrough", 10, 20, 512, 10, 20},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := scaleTo(tc.srcW, tc.srcH, tc.maxDim)
			if got.Dx() != tc.wantW || got.Dy() != tc.wantH {
				t.Errorf("scaleTo(%d,%d,%d) = %dx%d, want %dx%d",
					tc.srcW, tc.srcH, tc.maxDim, got.Dx(), got.Dy(), tc.wantW, tc.wantH)
			}
		})
	}
}
