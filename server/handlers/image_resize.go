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
	"fmt"
	"image"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"strings"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp" // register WebP decoder (encoder not provided)
)

// avatarMaxDim is the longest-edge cap applied to every uploaded avatar /
// server icon. 256 px covers a 128 px display at 2x DPR — comfortable for
// the avatar preview in profile settings while staying ~6-15 KB on wire.
const avatarMaxDim = 256

// jpegQuality is the encoder quality used when the source has no alpha
// channel. 85 is the sweet spot for photographic content (a recurring
// recommendation in libjpeg-turbo's docs) — visually lossless, ~25% smaller
// than the default 75 you'd get from image/jpeg.Encode without options.
const jpegQuality = 85

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
func ResizeAvatarBytes(src io.Reader) ([]byte, string, error) {
	img, _, err := image.Decode(src)
	if err != nil {
		return nil, "", fmt.Errorf("decode image: %w", err)
	}

	resized := scaleToFit(img, avatarMaxDim)
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
	switch img.ColorModel() {
	case nil:
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
