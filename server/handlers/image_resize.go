// Package handlers — image_resize.go: pure-Go avatar/icon downscale pipeline.
//
// Avatar uploads used to land on disk at their original dimensions (often
// 1024×1024 or larger), which Lighthouse (Mayıs 28 2026) flagged on
// /channels: 5+ avatars × ~1.3 MiB each → ~5.9 MiB of wasted bandwidth on
// every member-list render. Displayed sizes are 24–32 px, so a fixed
// 256×256 cap is enough headroom for HiDPI and the avatar-upload preview
// without paying the original cost.
//
// Why pure Go (no CGO):
//   - libvips / libwebp would give us WebP encode + faster scaling, but the
//     production image (debian:bookworm-slim) deliberately avoids CGO build
//     deps for reproducibility (Dockerfile lines 32-33 comments).
//   - golang.org/x/image/draw with CatmullRom is the highest-quality pure-Go
//     resampler; benchmarked at ~10 ms for 1024² → 256² on the HF runner —
//     negligible against the user-perceived upload latency.
//   - PNG (alpha preserved) and JPEG (quality 85) encoders ship with the
//     standard library; that handles every avatar format we accept.
//
// WebP / AVIF encode is deliberately out of scope for the first pass — the
// resize alone removes 90%+ of the wasted bytes.
package handlers

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"strings"

	"golang.org/x/image/draw"
	// Blank imports register decoders with the image package. We never call
	// gif.* or webp.* directly — image.Decode picks them up via init() — but
	// without these the decoder for animated avatars or webp uploads
	// disappears.
	_ "golang.org/x/image/webp"
	_ "image/gif"
)

// avatarMaxDim is the longest-edge cap applied to every uploaded avatar /
// server icon. 256 px covers a 128 px display at 2x DPR — comfortable for
// the avatar preview in profile settings while staying ~6-15 KB on wire.
const avatarMaxDim = 256

// maxAvatarDecodePixels caps the W×H the decoder is allowed to allocate a
// pixel buffer for. image.DecodeConfig reads only the header (IHDR / JFIF
// SOF / etc.) — no IDAT/scan data — so this check runs BEFORE any pixel
// buffer is allocated.
//
// Measured 2026-08-01, Docker (`--memory=2g`): a 72-byte PNG carrying a
// valid IHDR declaring 30000×30000 plus an immediately truncated IDAT drove
// image.DecodeConfig's heap to ~1 MB, then image.Decode's heap to ~3433 MB
// for the same input — but the process did NOT die; the decoder returned
// "png: invalid format: not enough pixel data" instead of crashing, because
// Go's large slice allocations go through mmap and pages that are never
// touched don't become resident RSS. So a guaranteed process kill is not
// what this guard is proven to prevent. What is proven: a handful of input
// bytes can force a multi-GB buffer *reservation* keyed only off attacker-
// controlled header fields, at negligible cost to the attacker, and that
// reservation multiplies with concurrent requests — see decodeSlots below
// for the concurrency half of this fix.
//
// The output is downscaled to avatarMaxDim (256 px) regardless of input
// size, so 25 megapixels (e.g. 5000×5000, ≈380x the pixel count a 256 px
// avatar actually needs) is ample headroom for any legitimate upload while
// bounding the worst-case RGBA decode buffer to ~100 MB.
const maxAvatarDecodePixels = 25_000_000

// ErrImageTooLarge is returned when the source image's declared dimensions
// exceed maxAvatarDecodePixels. Callers should map this to a 400 response
// distinct from "not a supported image format".
var ErrImageTooLarge = errors.New("image dimensions too large")

// jpegQuality is the encoder quality used when the source has no alpha
// channel. 85 is the sweet spot for photographic content (a recurring
// recommendation in libjpeg-turbo's docs) — visually lossless, ~25% smaller
// than the default 75 you'd get from image/jpeg.Encode without options.
const jpegQuality = 85

// decodeSlots bounds how many full-image decodes (the allocation-heavy step
// maxAvatarDecodePixels caps per-request) run concurrently.
//
// Rate limiting bounds how OFTEN a user may upload; it does not bound how
// many decodes run AT ONCE. Without this, N concurrent uploads each hold a
// full-size pixel buffer simultaneously and the ceiling is N × maxPixels,
// not maxPixels. Four is enough to keep the CPU busy on the single
// production container while capping the decode arena at ~400 MB.
var decodeSlots = make(chan struct{}, 4)

// decodeAndScale decodes the full pixel data from src and downscales it to
// maxDim, holding a decodeSlots slot for the duration of both steps. The
// pixel-count guard in ResizeAvatarBytes (image.DecodeConfig + the
// maxAvatarDecodePixels check) deliberately runs before this call and
// outside the semaphore: it only reads the header, never allocates a pixel
// buffer, so it doesn't need to queue.
func decodeAndScale(src io.Reader, maxDim int) (image.Image, error) {
	decodeSlots <- struct{}{}
	defer func() { <-decodeSlots }()

	img, _, err := image.Decode(src)
	if err != nil {
		return nil, fmt.Errorf("decode image: %w", err)
	}
	return scaleToFit(img, maxDim), nil
}

// ResizeAvatarBytes downscales the image read from src (any of jpeg / png /
// gif / webp) so its longest edge is at most avatarMaxDim, then re-encodes
// to PNG (when the source has an alpha channel) or JPEG (when it doesn't).
//
// Returns the encoded bytes and the file extension to use on disk
// (".png" or ".jpg"). The caller is responsible for rewriting the URL/
// filename to match the returned extension.
//
// Images already smaller than avatarMaxDim are still re-encoded — this
// normalizes the output format and strips any non-image metadata that may
// have been packed into the source (EXIF GPS tags etc.).
//
// src must be an io.ReadSeeker (not just io.Reader): image.DecodeConfig
// below consumes bytes from src to read the header, and the full
// image.Decode call afterward needs to start from byte 0 again. A
// MultiReader replay (buffer the first N bytes, then chain) is not enough
// here — a JPEG's SOF marker (which carries the width/height we need to
// bounds-check) can sit 64 KB+ into the file behind EXIF segments, so a
// small fixed-size replay buffer would truncate legitimate JPEGs. Buffering
// the whole upload instead would cost ~8 MB of extra RSS per request. Seek
// back to the start is exact and free. Both call sites already hand us a
// seekable value: multipart.File embeds io.Seeker (avatar.go), and
// cmd/resize_avatars/main.go opens files via os.Root, which returns *os.File.
func ResizeAvatarBytes(src io.ReadSeeker) ([]byte, string, error) {
	cfg, _, err := image.DecodeConfig(src)
	if err != nil {
		return nil, "", fmt.Errorf("decode image config: %w", err)
	}
	if cfg.Width <= 0 || cfg.Height <= 0 ||
		int64(cfg.Width)*int64(cfg.Height) > maxAvatarDecodePixels {
		return nil, "", fmt.Errorf("%w: %dx%d exceeds %d pixels",
			ErrImageTooLarge, cfg.Width, cfg.Height, maxAvatarDecodePixels)
	}
	if _, err := src.Seek(0, io.SeekStart); err != nil {
		return nil, "", fmt.Errorf("rewind image: %w", err)
	}

	resized, err := decodeAndScale(src, avatarMaxDim)
	if err != nil {
		return nil, "", err
	}
	hasAlpha := imageHasAlpha(resized)

	var buf bytes.Buffer
	if hasAlpha {
		if err := png.Encode(&buf, resized); err != nil {
			return nil, "", fmt.Errorf("encode png: %w", err)
		}
		return buf.Bytes(), ".png", nil
	}

	if err := jpeg.Encode(&buf, resized, &jpeg.Options{Quality: jpegQuality}); err != nil {
		return nil, "", fmt.Errorf("encode jpeg: %w", err)
	}
	return buf.Bytes(), ".jpg", nil
}

// scaleToFit returns img unchanged if its longest edge is already <= maxDim,
// otherwise produces a Catmull-Rom-resampled RGBA copy whose longest edge is
// maxDim and whose aspect ratio matches the source.
func scaleToFit(img image.Image, maxDim int) image.Image {
	b := img.Bounds()
	srcW := b.Dx()
	srcH := b.Dy()
	if srcW <= maxDim && srcH <= maxDim {
		return img
	}

	var dstW, dstH int
	if srcW >= srcH {
		dstW = maxDim
		// Round to nearest to avoid a 1px aspect drift on portrait inputs
		// that JPEG decoders sometimes amplify when the dimension is odd.
		dstH = (srcH*maxDim + srcW/2) / srcW
	} else {
		dstH = maxDim
		dstW = (srcW*maxDim + srcH/2) / srcH
	}

	dst := image.NewRGBA(image.Rect(0, 0, dstW, dstH))
	draw.CatmullRom.Scale(dst, dst.Rect, img, b, draw.Over, nil)
	return dst
}

// imageHasAlpha reports whether any pixel in img is less than fully opaque.
// The fast path checks the declared color model first — image/jpeg always
// gives back a YCbCr / RGB image with no alpha, so we can skip the scan.
// For PNG / WebP / GIF the model carries alpha even when every pixel is
// opaque, so we walk the bounds and bail on the first translucent pixel.
func imageHasAlpha(img image.Image) bool {
	if img.ColorModel() == nil {
		return true
	}
	// JPEG sources never carry transparency.
	if _, isYCbCr := img.(*image.YCbCr); isYCbCr {
		return false
	}
	b := img.Bounds()
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			_, _, _, a := img.At(x, y).RGBA()
			if a < 0xffff {
				return true
			}
		}
	}
	return false
}

// SwapExtension replaces the trailing extension on a filename with a new
// one (which must start with "."). Used by the avatar upload handler to
// rewrite "<random>_picture.png" → "<random>_picture.jpg" when the resize
// pipeline re-encodes a PNG as JPEG (alpha-less source).
func SwapExtension(filename string, newExt string) string {
	dot := strings.LastIndex(filename, ".")
	if dot < 0 {
		return filename + newExt
	}
	return filename[:dot] + newExt
}
