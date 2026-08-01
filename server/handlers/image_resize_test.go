// Package handlers -- tests for the pixel-bomb guard in ResizeAvatarBytes.
//
// SAFETY RULE: the truncated-IHDR "bomb" fixture built here must NEVER be
// handed directly to image.Decode / png.Decode. Go's png decoder allocates
// the destination pixel buffer from the IHDR width/height as soon as it
// parses the header -- long before it would notice the missing IDAT data --
// so decoding the 30000x30000 fixture without the maxAvatarDecodePixels
// guard would try to allocate ~3.6 GB and could kill the test process.
// Every case below goes through ResizeAvatarBytes only, so the guard is
// always exercised first.
package handlers

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"sync"
	"testing"
)

// buildTruncatedPNGBomb constructs a minimal-but-valid PNG signature + IHDR
// chunk declaring width x height, then stops -- no PLTE/IDAT/IEND follows.
// A real decoder never reaches pixel data; the point is that IHDR alone
// carries everything image.DecodeConfig (and the pixel-buffer allocation a
// full image.Decode would perform) needs.
func buildTruncatedPNGBomb(width, height uint32) []byte {
	var buf bytes.Buffer
	buf.Write([]byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A}) // PNG signature

	ihdrData := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdrData[0:4], width)
	binary.BigEndian.PutUint32(ihdrData[4:8], height)
	ihdrData[8] = 8  // bit depth
	ihdrData[9] = 6  // color type: truecolor with alpha
	ihdrData[10] = 0 // compression method
	ihdrData[11] = 0 // filter method
	ihdrData[12] = 0 // interlace method

	chunkType := []byte("IHDR")
	var lenBuf, crcBuf [4]byte
	binary.BigEndian.PutUint32(lenBuf[:], uint32(len(ihdrData)))
	buf.Write(lenBuf[:])
	buf.Write(chunkType)
	buf.Write(ihdrData)

	crcInput := append(append([]byte{}, chunkType...), ihdrData...)
	binary.BigEndian.PutUint32(crcBuf[:], crc32.ChecksumIEEE(crcInput))
	buf.Write(crcBuf[:])

	return buf.Bytes() // ~33 bytes total -- no IDAT/IEND, deliberately truncated
}

// newSolidRGBA returns a w x h image filled uniformly with c.
func newSolidRGBA(w, h int, c color.RGBA) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.SetRGBA(x, y, c)
		}
	}
	return img
}

func encodePNGFixture(t *testing.T, img image.Image) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode fixture png: %v", err)
	}
	return buf.Bytes()
}

// TestResizeAvatarBytes_RejectsDecodeBomb is the core regression test for
// the pixel-count guard: a 30000x30000 IHDR (900M pixels, ~3.6 GB as RGBA)
// must be rejected via ErrImageTooLarge before any pixel buffer is
// allocated.
//
// VACUITY CHECK (performed manually during implementation, then reverted):
// the guard's condition in image_resize.go --
//
//	int64(cfg.Width)*int64(cfg.Height) > maxAvatarDecodePixels
//
// -- was temporarily replaced with the literal `false` (guard permanently
// open) to confirm this test actually depends on it. With the guard
// disabled, ResizeAvatarBytes stops returning ErrImageTooLarge for the
// bomb fixture -- errors.Is(err, ErrImageTooLarge) below would go from
// true to false (the call instead falls through to image.Decode on the
// truncated bytes, which fails on missing IDAT with a plain "unexpected
// EOF"-style error rather than ErrImageTooLarge), so this test turns red.
// I could not execute `go test` in this environment to observe this
// directly (Windows + libsql cgo restriction -- see task constraints);
// this was verified by static trace of image_resize.go's control flow
// instead, and MUST be re-verified live by the Docker test runner (Faz 3)
// before this is treated as proven.
func TestResizeAvatarBytes_RejectsDecodeBomb(t *testing.T) {
	bomb := buildTruncatedPNGBomb(30000, 30000)

	_, _, err := ResizeAvatarBytes(bytes.NewReader(bomb))
	if err == nil {
		t.Fatal("expected an error for a 30000x30000 IHDR, got nil")
	}
	if !errors.Is(err, ErrImageTooLarge) {
		t.Fatalf("expected ErrImageTooLarge, got: %v", err)
	}
}

// TestResizeAvatarBytes_DimensionBoundary checks both sides of the pixel
// cap: a declared-oversized image is rejected, a small real image is not.
func TestResizeAvatarBytes_DimensionBoundary(t *testing.T) {
	t.Run("30000x30000 rejected", func(t *testing.T) {
		bomb := buildTruncatedPNGBomb(30000, 30000)
		_, _, err := ResizeAvatarBytes(bytes.NewReader(bomb))
		if !errors.Is(err, ErrImageTooLarge) {
			t.Fatalf("expected ErrImageTooLarge, got: %v", err)
		}
	})

	t.Run("100x100 accepted", func(t *testing.T) {
		src := encodePNGFixture(t, newSolidRGBA(100, 100, color.RGBA{R: 10, G: 20, B: 30, A: 255}))
		if _, _, err := ResizeAvatarBytes(bytes.NewReader(src)); err != nil {
			t.Fatalf("expected a real 100x100 PNG to be accepted, got: %v", err)
		}
	})

	// 5000x5000 == exactly 25,000,000 pixels == maxAvatarDecodePixels. The
	// guard's condition is "> maxAvatarDecodePixels", so equality must pass.
	// This fixture is a bomb (truncated IHDR, no IDAT/IEND) rather than a
	// real 25 MP image on purpose: decoding a genuine 25 MP PNG here would
	// allocate the full ~100 MB pixel buffer this test is meant to avoid
	// paying for, just to prove the guard lets it through. The bomb still
	// proves the boundary — it only fails past the guard, on the missing
	// pixel data, and image.Decode returning any non-ErrImageTooLarge error
	// (not "nil error") is exactly the signal that the guard did not reject
	// it.
	t.Run("5000x5000 (exactly at cap) accepted by the guard", func(t *testing.T) {
		bomb := buildTruncatedPNGBomb(5000, 5000)
		_, _, err := ResizeAvatarBytes(bytes.NewReader(bomb))
		if errors.Is(err, ErrImageTooLarge) {
			t.Fatalf("5000x5000 (25,000,000 px) sits exactly at maxAvatarDecodePixels and must not be rejected by the pixel guard; got: %v", err)
		}
		if err == nil {
			t.Fatal("expected a non-nil error from the truncated IDAT (bomb has no pixel data), but the guard correctly let it past the size check")
		}
	})

	// 5001x5000 == 25,005,000 pixels, one row over the cap. Must be
	// rejected by the pixel guard specifically (ErrImageTooLarge), not by
	// some other decode failure.
	t.Run("5001x5000 (one row over cap) rejected", func(t *testing.T) {
		bomb := buildTruncatedPNGBomb(5001, 5000)
		_, _, err := ResizeAvatarBytes(bytes.NewReader(bomb))
		if !errors.Is(err, ErrImageTooLarge) {
			t.Fatalf("expected ErrImageTooLarge for 5001x5000 (25,005,000 px), got: %v", err)
		}
	})
}

// TestResizeAvatarBytes_RoundTripPNG is the regression test for the
// Seek(0) rewind between image.DecodeConfig and image.Decode: without it,
// image.Decode would read from wherever DecodeConfig left off (past the
// header) and fail on every real image, not just the bomb fixture.
//
// The fixture is uniformly semi-transparent (A: 200) so the alpha survives
// the CatmullRom downscale at every pixel, keeping the PNG (alpha)
// encoding path deterministic regardless of resample rounding at the
// edges.
func TestResizeAvatarBytes_RoundTripPNG(t *testing.T) {
	src := encodePNGFixture(t, newSolidRGBA(300, 200, color.RGBA{R: 50, G: 100, B: 150, A: 200}))

	out, ext, err := ResizeAvatarBytes(bytes.NewReader(src))
	if err != nil {
		t.Fatalf("ResizeAvatarBytes: %v", err)
	}
	if ext != ".png" {
		t.Fatalf("expected .png extension for a source with alpha, got %q", ext)
	}

	decoded, _, err := image.Decode(bytes.NewReader(out))
	if err != nil {
		t.Fatalf("re-decoding resized PNG output: %v", err)
	}
	b := decoded.Bounds()
	if b.Dx() > avatarMaxDim || b.Dy() > avatarMaxDim {
		t.Fatalf("resized image exceeds avatarMaxDim (%d): got %dx%d", avatarMaxDim, b.Dx(), b.Dy())
	}
}

// TestResizeAvatarBytes_RoundTripJPEG mirrors the PNG round-trip for a
// JPEG source (no alpha channel -- image/jpeg always decodes to YCbCr/Gray).
func TestResizeAvatarBytes_RoundTripJPEG(t *testing.T) {
	img := newSolidRGBA(300, 200, color.RGBA{R: 200, G: 100, B: 50, A: 255})
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatalf("encode fixture jpeg: %v", err)
	}

	out, ext, err := ResizeAvatarBytes(bytes.NewReader(buf.Bytes()))
	if err != nil {
		t.Fatalf("ResizeAvatarBytes: %v", err)
	}
	if ext != ".jpg" {
		t.Fatalf("expected .jpg extension for an alpha-less source, got %q", ext)
	}

	decoded, _, err := image.Decode(bytes.NewReader(out))
	if err != nil {
		t.Fatalf("re-decoding resized JPEG output: %v", err)
	}
	b := decoded.Bounds()
	if b.Dx() > avatarMaxDim || b.Dy() > avatarMaxDim {
		t.Fatalf("resized image exceeds avatarMaxDim (%d): got %dx%d", avatarMaxDim, b.Dx(), b.Dy())
	}
}

// TestResizeAvatarBytes_RejectsUnregisteredFormat pins the decoder set: the
// binary must not link any decoder beyond jpeg/png/gif/webp (image_resize.go's
// imports). A bare BMP magic ("BM" + a zeroed header) should fail with
// "unknown format" from image.Decode -- not with ErrImageTooLarge, and not
// by succeeding.
func TestResizeAvatarBytes_RejectsUnregisteredFormat(t *testing.T) {
	bmp := append([]byte("BM"), make([]byte, 52)...)

	_, _, err := ResizeAvatarBytes(bytes.NewReader(bmp))
	if err == nil {
		t.Fatal("expected an error for an unregistered BMP format, got nil")
	}
	if errors.Is(err, ErrImageTooLarge) {
		t.Fatal("BMP fixture should fail on unknown format, not the pixel-size guard")
	}
}

// TestResizeAvatarBytes_ConcurrentDecodesSucceed exercises the decodeSlots
// semaphore: many goroutines call ResizeAvatarBytes at once, each with its
// own small real PNG of a distinct size and color. decodeSlots caps how
// many of the image.Decode + scaleToFit steps run at the same instant (4,
// see image_resize.go), but every call must still complete and return the
// right result for its own input -- proving the semaphore only throttles
// concurrency, it does not deadlock, drop, or cross-contaminate results
// between callers. Intended to be run with -race to also catch any data
// race the semaphore's shared channel might introduce.
func TestResizeAvatarBytes_ConcurrentDecodesSucceed(t *testing.T) {
	const workers = 12

	var wg sync.WaitGroup
	errs := make([]error, workers)
	gotW := make([]int, workers)
	gotH := make([]int, workers)

	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()

			// Distinct per-goroutine size (all well under avatarMaxDim, so
			// no scaling happens and the round-tripped bounds must match
			// exactly) so a buffer mix-up between concurrent decodes would
			// surface as a wrong width/height below.
			w := 40 + i
			h := 30 + i
			c := color.RGBA{R: uint8(i * 15), G: uint8(255 - i*15), B: 128, A: 255}

			// Encode inline rather than via encodePNGFixture: that helper
			// calls t.Fatalf on error, and Fatal/FailNow may only be
			// called from the goroutine running the test function, not
			// from goroutines the test spawns.
			var srcBuf bytes.Buffer
			if err := png.Encode(&srcBuf, newSolidRGBA(w, h, c)); err != nil {
				errs[i] = fmt.Errorf("encode fixture png: %w", err)
				return
			}

			out, ext, err := ResizeAvatarBytes(bytes.NewReader(srcBuf.Bytes()))
			if err != nil {
				errs[i] = fmt.Errorf("ResizeAvatarBytes: %w", err)
				return
			}
			if ext != ".jpg" {
				errs[i] = fmt.Errorf("expected .jpg for an opaque source, got %q", ext)
				return
			}
			decoded, _, decErr := image.Decode(bytes.NewReader(out))
			if decErr != nil {
				errs[i] = fmt.Errorf("re-decoding resized output: %w", decErr)
				return
			}
			b := decoded.Bounds()
			gotW[i], gotH[i] = b.Dx(), b.Dy()
		}(i)
	}
	wg.Wait()

	for i := 0; i < workers; i++ {
		if errs[i] != nil {
			t.Errorf("worker %d: %v", i, errs[i])
			continue
		}
		wantW, wantH := 40+i, 30+i
		if gotW[i] != wantW || gotH[i] != wantH {
			t.Errorf("worker %d: expected %dx%d (source below avatarMaxDim, unscaled), got %dx%d", i, wantW, wantH, gotW[i], gotH[i])
		}
	}
}
