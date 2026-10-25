// Package handlers — image_gif.go: the avatar pipeline's animated branch.
//
// avatar_url always stays a static image. A GIF with two or more frames
// additionally produces an animated copy (avatar_animated_url): re-encoded
// by gif.EncodeAll, centre-cropped to a square and scaled to
// animatedAvatarDim, so — like the static path — every byte written to disk
// is encoder output (K-021), never the uploaded bytes.
//
// Why a separate pre-scan: image/gif's DecodeAll has no frame-count cap. It
// validates each frame against the logical screen, but an 8 MiB GIF can
// still declare thousands of frames and make DecodeAll allocate a pixel
// buffer for every one of them. ScanGIF walks the block structure without
// decompressing or allocating pixel data, so the frame / screen / total
// pixel budgets below are enforced before DecodeAll ever runs.
//
// Animated WebP is rejected outright: golang.org/x/image/webp cannot decode
// it, the standard library has no WebP encoder, and passing the original
// bytes through would serve unvalidated attacker bytes inline from the app
// origin (and leak EXIF/XMP).
package handlers

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/gif"
	"io"
	"time"

	"golang.org/x/image/draw"
)

// Animated-avatar budgets. Sized for the 2-vCPU production container.
const (
	maxAnimatedFrames       = 100
	maxAnimatedScreenPixels = 1_000_000  // logical-screen W×H from the GIF header
	maxAnimatedTotalPixels  = 40_000_000 // frames × screenW × screenH
	animatedAvatarDim       = 128        // square output edge (never scaled up)
	maxAnimatedOutputBytes  = 2 << 20    // encoded GIF; larger → 400
	animatedProcessTimeout  = 10 * time.Second
)

// animatedSlots serialises the animated branch (decode + composite + per-
// frame quantise + encode is far heavier than one static decode). It is
// separate from decodeSlots so a queued GIF never blocks static uploads.
var animatedSlots = make(chan struct{}, 1)

var (
	// ErrTooManyFrames — the GIF declares more than maxAnimatedFrames frames.
	ErrTooManyFrames = errors.New("animated image has too many frames")
	// ErrAnimatedWebPUnsupported — an animated WebP was uploaded.
	ErrAnimatedWebPUnsupported = errors.New("animated WebP is not supported; upload a GIF")
	// ErrAnimatedTooLarge — the re-encoded animated avatar exceeds
	// maxAnimatedOutputBytes.
	ErrAnimatedTooLarge = errors.New("animated avatar is too large after processing")
	// ErrImageBusy — the animated-processing slot could not be acquired (or
	// processing did not finish) before the deadline, or the request context
	// ended. Wraps the context error. Maps to 503.
	ErrImageBusy = errors.New("image processing is busy, please retry")
)

// AvatarResult is ProcessAvatar's output. Static is always set (the poster
// for animated input); Animated is nil unless the input was a multi-frame
// GIF.
type AvatarResult struct {
	Static    []byte
	StaticExt string // ".png" or ".jpg"
	Animated  []byte // GIF bytes, or nil
}

// ScanGIF walks a GIF's block structure and returns the image-descriptor
// count and the logical-screen size. It never decompresses LZW data and
// allocates no pixel buffers: it reads the header, skips colour tables and
// every sub-block chain, and checks that each frame rectangle lies inside
// the logical screen. It stops with ErrTooManyFrames as soon as the count
// exceeds maxFrames, and fails on any malformed or truncated structure
// (including a missing trailer).
func ScanGIF(r io.Reader, maxFrames int) (frames, screenW, screenH int, err error) {
	br := bufio.NewReader(r)
	var hdr [13]byte
	if _, err := io.ReadFull(br, hdr[:]); err != nil {
		return 0, 0, 0, fmt.Errorf("gif scan: reading header: %w", err)
	}
	if v := string(hdr[:6]); v != "GIF87a" && v != "GIF89a" {
		return 0, 0, 0, fmt.Errorf("gif scan: not a GIF")
	}
	screenW = int(hdr[6]) | int(hdr[7])<<8
	screenH = int(hdr[8]) | int(hdr[9])<<8
	if hdr[10]&0x80 != 0 {
		if err := skipBytes(br, colorTableSize(hdr[10])); err != nil {
			return 0, 0, 0, fmt.Errorf("gif scan: global colour table: %w", err)
		}
	}

	screen := image.Rect(0, 0, screenW, screenH)
	for {
		c, err := br.ReadByte()
		if err != nil {
			return 0, 0, 0, fmt.Errorf("gif scan: reading block: %w", err)
		}
		switch c {
		case 0x21: // extension
			// Each label is parsed exactly the way image/gif's readExtension
			// does. A generic "label + sub-blocks" walk would desynchronise
			// from the stdlib decoder (e.g. the Plain Text extension starts
			// with a fixed 13-byte header, not a sub-block), letting frames
			// hidden from this scan be decoded by gif.DecodeAll.
			if err := skipExtension(br); err != nil {
				return 0, 0, 0, fmt.Errorf("gif scan: extension: %w", err)
			}
		case 0x2C: // image descriptor
			var d [9]byte
			if _, err := io.ReadFull(br, d[:]); err != nil {
				return 0, 0, 0, fmt.Errorf("gif scan: image descriptor: %w", err)
			}
			left := int(d[0]) | int(d[1])<<8
			top := int(d[2]) | int(d[3])<<8
			w := int(d[4]) | int(d[5])<<8
			h := int(d[6]) | int(d[7])<<8
			if !image.Rect(left, top, left+w, top+h).In(screen) {
				return 0, 0, 0, fmt.Errorf("gif scan: frame bounds outside the logical screen")
			}
			if d[8]&0x80 != 0 {
				if err := skipBytes(br, colorTableSize(d[8])); err != nil {
					return 0, 0, 0, fmt.Errorf("gif scan: local colour table: %w", err)
				}
			} else if hdr[10]&0x80 == 0 {
				return 0, 0, 0, fmt.Errorf("gif scan: frame has no colour table")
			}
			litWidth, err := br.ReadByte() // LZW minimum code size
			if err != nil {
				return 0, 0, 0, fmt.Errorf("gif scan: LZW code size: %w", err)
			}
			if litWidth < 2 || litWidth > 8 {
				return 0, 0, 0, fmt.Errorf("gif scan: LZW code size %d out of range", litWidth)
			}
			if err := skipSubBlocks(br); err != nil {
				return 0, 0, 0, fmt.Errorf("gif scan: image data: %w", err)
			}
			frames++
			if frames > maxFrames {
				return 0, 0, 0, fmt.Errorf("%w: more than %d", ErrTooManyFrames, maxFrames)
			}
		case 0x3B: // trailer
			if frames == 0 {
				return 0, 0, 0, fmt.Errorf("gif scan: no image data")
			}
			return frames, screenW, screenH, nil
		default:
			return 0, 0, 0, fmt.Errorf("gif scan: unknown block type 0x%02x", c)
		}
	}
}

// colorTableSize returns the byte length of the colour table announced by a
// GIF packed-fields byte (3 bytes × 2^(n+1) entries).
func colorTableSize(packed byte) int {
	return 3 * (1 << (1 + uint(packed&0x07)))
}

func skipBytes(br *bufio.Reader, n int) error {
	_, err := br.Discard(n)
	return err
}

// skipExtension consumes one extension block (the 0x21 introducer already
// read), mirroring image/gif's readExtension label by label:
//   - 0x01 Plain Text: fixed 13-byte header, then a sub-block chain
//   - 0xF9 Graphic Control: fixed 6 bytes (size 4, data, terminator 0)
//   - 0xFE Comment: a sub-block chain
//   - 0xFF Application: a size byte, that many bytes, then a sub-block chain
//
// Any other label is an error, exactly as in image/gif.
func skipExtension(br *bufio.Reader) error {
	label, err := br.ReadByte()
	if err != nil {
		return err
	}
	switch label {
	case 0x01:
		if err := skipBytes(br, 13); err != nil {
			return err
		}
	case 0xF9:
		var gce [6]byte
		if _, err := io.ReadFull(br, gce[:]); err != nil {
			return err
		}
		if gce[0] != 4 || gce[5] != 0 {
			return fmt.Errorf("invalid graphic control extension")
		}
		return nil
	case 0xFE:
	case 0xFF:
		size, err := br.ReadByte()
		if err != nil {
			return err
		}
		if err := skipBytes(br, int(size)); err != nil {
			return err
		}
	default:
		return fmt.Errorf("unknown extension 0x%02x", label)
	}
	return skipSubBlocks(br)
}

// skipSubBlocks discards a GIF sub-block chain: length-prefixed blocks
// terminated by a zero-length block.
func skipSubBlocks(br *bufio.Reader) error {
	for {
		n, err := br.ReadByte()
		if err != nil {
			return err
		}
		if n == 0 {
			return nil
		}
		if err := skipBytes(br, int(n)); err != nil {
			return err
		}
	}
}

// IsAnimatedWebP reports whether head (the first bytes of a file, at least
// 21) is a WebP container with a VP8X chunk whose Animation flag (0x02) is
// set. Still WebPs (simple VP8/VP8L, or VP8X without the flag) return false.
func IsAnimatedWebP(head []byte) bool {
	return len(head) >= 21 &&
		string(head[0:4]) == "RIFF" &&
		string(head[8:12]) == "WEBP" &&
		string(head[12:16]) == "VP8X" &&
		head[20]&0x02 != 0
}

// readHead reads up to 32 bytes from the start of src for format sniffing,
// then rewinds src. A short file is not an error here; the decoders that
// run next reject it.
func readHead(src io.ReadSeeker) ([]byte, error) {
	head := make([]byte, 32)
	n, err := io.ReadFull(src, head)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("read image header: %w", err)
	}
	if _, err := src.Seek(0, io.SeekStart); err != nil {
		return nil, fmt.Errorf("rewind image: %w", err)
	}
	return head[:n], nil
}

// ProcessAvatar turns an uploaded avatar into a static image (always) plus
// an animated GIF (only for multi-frame GIF input). Static input of any
// supported format — and single-frame GIFs and APNGs, whose default image is
// all image/png decodes — goes through ResizeAvatarBytes unchanged.
//
// src must be seekable for the same reason as ResizeAvatarBytes: the header
// sniff, the GIF pre-scan and the decode each start from byte 0.
func ProcessAvatar(ctx context.Context, src io.ReadSeeker) (AvatarResult, error) {
	head, err := readHead(src)
	if err != nil {
		return AvatarResult{}, err
	}
	if IsAnimatedWebP(head) {
		return AvatarResult{}, ErrAnimatedWebPUnsupported
	}

	if bytes.HasPrefix(head, []byte("GIF8")) {
		frames, screenW, screenH, err := ScanGIF(src, maxAnimatedFrames)
		if err != nil {
			return AvatarResult{}, err
		}
		if _, err := src.Seek(0, io.SeekStart); err != nil {
			return AvatarResult{}, fmt.Errorf("rewind image: %w", err)
		}
		if frames >= 2 {
			return processAnimatedGIF(ctx, src, frames, screenW, screenH)
		}
	}

	static, ext, err := ResizeAvatarBytes(src)
	if err != nil {
		return AvatarResult{}, err
	}
	return AvatarResult{Static: static, StaticExt: ext}, nil
}

// processAnimatedGIF enforces the screen and total-pixel budgets (before any
// pixel allocation), then decodes, composites, crops, scales and re-encodes
// every frame while holding an animatedSlots slot.
func processAnimatedGIF(ctx context.Context, src io.Reader, frames, screenW, screenH int) (AvatarResult, error) {
	screenPixels := int64(screenW) * int64(screenH)
	if screenW <= 0 || screenH <= 0 || screenPixels > maxAnimatedScreenPixels {
		return AvatarResult{}, fmt.Errorf("%w: animated %dx%d exceeds %d pixels",
			ErrImageTooLarge, screenW, screenH, maxAnimatedScreenPixels)
	}
	if int64(frames)*screenPixels > maxAnimatedTotalPixels {
		return AvatarResult{}, fmt.Errorf("%w: %d frames of %dx%d exceed %d total pixels",
			ErrImageTooLarge, frames, screenW, screenH, maxAnimatedTotalPixels)
	}

	// Every context failure (caller gone, deadline hit) surfaces as
	// ErrImageBusy wrapping the ctx error, so the handler has one mapping.
	if err := ctx.Err(); err != nil {
		return AvatarResult{}, fmt.Errorf("%w: %w", ErrImageBusy, err)
	}
	ctx, cancel := context.WithTimeout(ctx, animatedProcessTimeout)
	defer cancel()
	select {
	case animatedSlots <- struct{}{}:
	case <-ctx.Done():
		return AvatarResult{}, fmt.Errorf("%w: %w", ErrImageBusy, ctx.Err())
	}
	defer func() { <-animatedSlots }()

	g, err := gif.DecodeAll(src)
	if err != nil {
		return AvatarResult{}, fmt.Errorf("decode gif: %w", err)
	}
	// Defence in depth: ScanGIF mirrors image/gif's block grammar, so the
	// counts must agree. A mismatch means the two parsers disagree on this
	// input; refuse it rather than render frames the budgets never saw.
	if len(g.Image) != frames || len(g.Image) > maxAnimatedFrames {
		return AvatarResult{}, fmt.Errorf("%w: decoder saw %d frames, scan saw %d",
			ErrTooManyFrames, len(g.Image), frames)
	}
	return renderAnimated(ctx, g)
}

// renderAnimated composites g's frames onto a logical-screen canvas
// (honouring each frame's disposal method), and emits every composited
// canvas as one full-frame output frame: centre-cropped square, BiLinear-
// scaled to at most animatedAvatarDim, Floyd–Steinberg-dithered onto the
// source frame's palette plus a transparent entry. Delays and LoopCount are
// preserved; output frames use DisposalBackground so transparent pixels
// never show a previous frame. The poster is composited frame 0.
func renderAnimated(ctx context.Context, g *gif.GIF) (AvatarResult, error) {
	screen := image.Rect(0, 0, g.Config.Width, g.Config.Height)
	canvas := image.NewRGBA(screen)
	crop := centerCropSquare(screen)

	out := &gif.GIF{LoopCount: g.LoopCount}
	var poster []byte
	var posterExt string

	for i, frame := range g.Image {
		if err := ctx.Err(); err != nil {
			return AvatarResult{}, fmt.Errorf("%w: %w", ErrImageBusy, err)
		}

		disposal := byte(gif.DisposalNone)
		if i < len(g.Disposal) {
			disposal = g.Disposal[i]
		}
		var saved *image.RGBA
		if disposal == gif.DisposalPrevious {
			saved = image.NewRGBA(screen)
			copy(saved.Pix, canvas.Pix)
		}

		draw.Draw(canvas, frame.Bounds(), frame, frame.Bounds().Min, draw.Over)

		if i == 0 {
			p := cropScale(canvas, crop, avatarMaxDim, draw.CatmullRom)
			var err error
			if poster, posterExt, err = encodeStatic(p); err != nil {
				return AvatarResult{}, err
			}
		}

		scaled := cropScale(canvas, crop, animatedAvatarDim, draw.BiLinear)
		out.Image = append(out.Image, quantizeFrame(scaled, frame.Palette))
		delay := 0
		if i < len(g.Delay) {
			delay = g.Delay[i]
		}
		out.Delay = append(out.Delay, delay)
		out.Disposal = append(out.Disposal, gif.DisposalBackground)

		switch disposal {
		case gif.DisposalBackground:
			draw.Draw(canvas, frame.Bounds(), image.Transparent, image.Point{}, draw.Src)
		case gif.DisposalPrevious:
			canvas = saved
		}
	}

	var buf bytes.Buffer
	if err := gif.EncodeAll(&buf, out); err != nil {
		return AvatarResult{}, fmt.Errorf("encode gif: %w", err)
	}
	if buf.Len() > maxAnimatedOutputBytes {
		return AvatarResult{}, fmt.Errorf("%w: %d bytes exceeds %d",
			ErrAnimatedTooLarge, buf.Len(), maxAnimatedOutputBytes)
	}
	return AvatarResult{Static: poster, StaticExt: posterExt, Animated: buf.Bytes()}, nil
}

// quantizeFrame maps img onto src's opaque colours (at most 255) plus one
// transparent entry. Pixels with alpha >= 0x8000 are made opaque and
// Floyd–Steinberg-dithered; pixels below that become the transparent index.
func quantizeFrame(img *image.RGBA, src color.Palette) *image.Paletted {
	opaque := make(color.Palette, 0, 256)
	for _, c := range src {
		if _, _, _, a := c.RGBA(); a == 0xffff {
			opaque = append(opaque, c)
			if len(opaque) == 255 {
				break
			}
		}
	}
	if len(opaque) == 0 {
		opaque = append(opaque, color.Black)
	}
	transparent := uint8(len(opaque) % 256)
	pal := make(color.Palette, len(opaque)+1)
	copy(pal, opaque)
	pal[len(opaque)] = color.RGBA{}

	b := img.Bounds()
	mask := make([]bool, b.Dx()*b.Dy())
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			c := img.RGBAAt(x, y)
			if uint32(c.A)*0x101 < 0x8000 {
				mask[(y-b.Min.Y)*b.Dx()+(x-b.Min.X)] = true
				continue
			}
			if c.A != 0xff { // un-premultiply to an opaque colour
				c = color.RGBA{
					R: unpremultiplyRGBA(c.R, c.A),
					G: unpremultiplyRGBA(c.G, c.A),
					B: unpremultiplyRGBA(c.B, c.A),
					A: 0xff,
				}
				img.SetRGBA(x, y, c)
			}
		}
	}

	// Dither against the opaque colours only, so no opaque pixel is ever
	// matched to the transparent entry; the mask then punches transparency.
	dst := image.NewPaletted(b, pal)
	dither := image.NewPaletted(b, opaque)
	draw.FloydSteinberg.Draw(dither, b, img, b.Min)
	copy(dst.Pix, dither.Pix)
	for i, t := range mask {
		if t {
			dst.Pix[i] = transparent
		}
	}
	return dst
}

func unpremultiplyRGBA(component, alpha uint8) uint8 {
	if alpha == 0 {
		return 0
	}
	if component > alpha {
		component = alpha
	}
	value := uint16(component) * 0xff / uint16(alpha)
	return uint8(value & 0xff)
}
