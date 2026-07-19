// Package thumbnail — pure image resizing for chat attachments.
//
// The upload path (services/upload_service, services/dm_upload_service)
// owns "read the file from disk" and "write the thumbnail row into the
// DB". This package owns exactly the middle step: decode source bytes,
// resize proportionally to fit inside a max dimension, encode as JPEG.
//
// Constraints deliberately baked in here rather than pushed to callers:
//   - JPEG output only. WebP would need a non-stdlib encoder; PNG
//     thumbnails would double the storage vs the same-visual-quality
//     JPEG. Chat clients render "small preview" the same either way.
//   - Max side is a hard cap. Even if the caller asks for 4096, the
//     package clamps to hardMaxDimension so no single caller can pin
//     a whole GPU / CPU render loop.
//   - Fixed encoding quality (85). Below ~75 the JPEG blocking gets
//     noticeable on chat-size previews; above ~90 file size grows
//     faster than perceptible quality. 85 is the standard mid-point.
//
// Everything is a pure function of the input bytes — no disk, no
// network, no random state. That keeps the tests simple and lets a
// future WebP or AVIF path drop in as sibling functions without
// breaking callers.
package thumbnail

import (
	"errors"
	"image"
	"image/jpeg"
	// Register stdlib decoders. Without these blank imports, image.Decode
	// only knows the format it was linked against (usually PNG); GIF and
	// JPEG source uploads would return ErrUnsupportedFormat.
	_ "image/gif"
	_ "image/png"
	"io"

	"golang.org/x/image/draw"
)

// Options control the resize + encode behavior. Zero-value options are
// safe: MaxDimension falls back to DefaultMaxDimension, JPEGQuality
// falls back to DefaultJPEGQuality.
type Options struct {
	// MaxDimension is the largest allowed side (width OR height) of the
	// output thumbnail in pixels. Aspect ratio is preserved: a 4000x2000
	// input with MaxDimension=512 produces 512x256, not 512x512.
	MaxDimension int
	// JPEGQuality is passed straight to jpeg.Options. Range 1-100.
	JPEGQuality int
}

const (
	// DefaultMaxDimension — 512 fits the common "message list inline
	// preview" size across the client's 1x and 2x DPR ladders (128 CSS
	// px * 4 for hi-DPI). Bigger just wastes bytes; smaller looks blurry
	// on retina.
	DefaultMaxDimension = 512
	// hardMaxDimension caps the caller-provided value. A caller that
	// asks for a 4k thumbnail almost certainly has a bug or is
	// misconfigured — 2048 is generous headroom for genuine hi-DPI
	// needs while stopping a single request from pinning the encoder.
	hardMaxDimension = 2048
	// DefaultJPEGQuality — 85 is the standard "visually lossless for
	// small images" mid-point. Below ~75 JPEG blocking is noticeable
	// on thumbnails; above ~90 file size grows faster than quality.
	DefaultJPEGQuality = 85
)

// ErrUnsupportedFormat is returned when image.Decode can't recognize
// the source bytes as PNG / JPEG / GIF. Callers should treat this as
// "no thumbnail available" and continue, not as a fatal upload error —
// the source file itself is still fine, we just don't generate a
// preview for it.
var ErrUnsupportedFormat = errors.New("thumbnail: unsupported source format")

// Generate reads an image from src, resizes it to fit inside
// opts.MaxDimension while preserving aspect ratio, and writes JPEG
// bytes to dst. Returns ErrUnsupportedFormat if src can't be decoded
// as PNG / JPEG / GIF (chat's currently supported inline-preview
// formats — the four image/* entries in the upload allowlist).
//
// If the source is already smaller than MaxDimension in BOTH
// dimensions, it's re-encoded as JPEG at the same size (still cheaper
// storage than shipping the raw PNG in most cases, and callers get a
// stable output format).
func Generate(dst io.Writer, src io.Reader, opts Options) error {
	maxDim := opts.MaxDimension
	if maxDim <= 0 {
		maxDim = DefaultMaxDimension
	}
	if maxDim > hardMaxDimension {
		maxDim = hardMaxDimension
	}
	quality := opts.JPEGQuality
	if quality <= 0 || quality > 100 {
		quality = DefaultJPEGQuality
	}

	sourceImg, _, err := image.Decode(src)
	if err != nil {
		return ErrUnsupportedFormat
	}

	targetBounds := scaleTo(sourceImg.Bounds().Dx(), sourceImg.Bounds().Dy(), maxDim)
	// A degenerate 0x0 source would produce a 0x0 target and confuse
	// jpeg.Encode; refuse rather than emit an invalid file.
	if targetBounds.Dx() <= 0 || targetBounds.Dy() <= 0 {
		return ErrUnsupportedFormat
	}

	resized := image.NewRGBA(targetBounds)
	// CatmullRom picks quality over speed — draw.ApproxBiLinear would
	// be faster but visibly softer at the 4x downscale ratios common
	// for phone-camera uploads (4000+ px → 512 px thumbnail).
	draw.CatmullRom.Scale(
		resized, targetBounds,
		sourceImg, sourceImg.Bounds(),
		draw.Over, nil,
	)

	return jpeg.Encode(dst, resized, &jpeg.Options{Quality: quality})
}

// scaleTo computes the target rectangle for a proportional resize
// where the LONGER side becomes maxDim. Public-shaped so it can be
// unit-tested without an actual image.
func scaleTo(srcW, srcH, maxDim int) image.Rectangle {
	if srcW <= maxDim && srcH <= maxDim {
		return image.Rect(0, 0, srcW, srcH)
	}
	var targetW, targetH int
	if srcW >= srcH {
		targetW = maxDim
		targetH = (srcH * maxDim) / srcW
		if targetH < 1 {
			targetH = 1
		}
	} else {
		targetH = maxDim
		targetW = (srcW * maxDim) / srcH
		if targetW < 1 {
			targetW = 1
		}
	}
	return image.Rect(0, 0, targetW, targetH)
}
