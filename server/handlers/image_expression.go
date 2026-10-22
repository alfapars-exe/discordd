// Package handlers — image_expression.go: the image pipeline for server
// custom emojis (and, later, stickers).
//
// Same rules as the avatar pipeline (K-021): the decoders are the only
// format gate, and every byte written to disk is encoder output. Static
// output is always PNG (png.Encode) so the emoji URL can be derived from its
// id alone; a multi-frame GIF additionally yields an animated GIF
// (gif.EncodeAll). Both are scaled to FIT the profile's edge — aspect ratio
// kept, never cropped, never scaled up — unlike avatars, which are
// centre-cropped squares.
//
// Animated input reuses image_gif.go's helpers and budgets unchanged
// (ScanGIF pre-scan before gif.DecodeAll, screen and total-pixel budgets,
// the animatedSlots semaphore, quantizeFrame). renderAnimatedFit below is a
// copy of renderAnimated's composite loop with the crop replaced by the full
// logical screen and a PNG poster; once the Faz F commit lands, both should
// be refactored onto one shared renderFrames.
package handlers

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/gif"
	"image/png"
	"io"

	"golang.org/x/image/draw"
)

// ExpressionProfile sizes one expression kind's output.
type ExpressionProfile struct {
	// Dim is the longest-edge cap of both outputs.
	Dim int
	// MaxDecodePixels caps the W×H a static source may declare (checked
	// from the header before any pixel buffer is allocated).
	MaxDecodePixels int
	// MaxAnimatedOutput caps the encoded animated GIF in bytes.
	MaxAnimatedOutput int
}

// ExpressionEmoji is the custom-emoji profile: 128 px, 4 MP static decode
// ceiling, 512 KiB animated output.
var ExpressionEmoji = ExpressionProfile{Dim: 128, MaxDecodePixels: 4_000_000, MaxAnimatedOutput: 512 << 10}

// ExpressionImage is ProcessExpressionImage's output. Static is always a
// PNG (the poster for animated input); Animated is a GIF, or nil unless the
// input was a multi-frame GIF.
type ExpressionImage struct {
	Static   []byte
	Animated []byte
}

// ProcessExpressionImage validates and re-encodes an uploaded expression
// image. Animated WebP is rejected (ErrAnimatedWebPUnsupported); a GIF is
// pre-scanned with ScanGIF and, with two or more frames, takes the animated
// branch; everything else (including single-frame GIFs and APNGs, whose
// default image is all image/png decodes) is decoded once and re-encoded as
// PNG. src must be seekable: the sniff, the pre-scan, the header check and
// the decode each start from byte 0.
func ProcessExpressionImage(ctx context.Context, src io.ReadSeeker, p ExpressionProfile) (ExpressionImage, error) {
	head, err := readHead(src)
	if err != nil {
		return ExpressionImage{}, err
	}
	if IsAnimatedWebP(head) {
		return ExpressionImage{}, ErrAnimatedWebPUnsupported
	}

	if bytes.HasPrefix(head, []byte("GIF8")) {
		frames, screenW, screenH, err := ScanGIF(src, maxAnimatedFrames)
		if err != nil {
			return ExpressionImage{}, err
		}
		if _, err := src.Seek(0, io.SeekStart); err != nil {
			return ExpressionImage{}, fmt.Errorf("rewind image: %w", err)
		}
		if frames >= 2 {
			return processAnimatedExpression(ctx, src, frames, screenW, screenH, p)
		}
	}

	cfg, _, err := image.DecodeConfig(src)
	if err != nil {
		return ExpressionImage{}, fmt.Errorf("decode image config: %w", err)
	}
	if cfg.Width <= 0 || cfg.Height <= 0 ||
		int64(cfg.Width)*int64(cfg.Height) > int64(p.MaxDecodePixels) {
		return ExpressionImage{}, fmt.Errorf("%w: %dx%d exceeds %d pixels",
			ErrImageTooLarge, cfg.Width, cfg.Height, p.MaxDecodePixels)
	}
	if _, err := src.Seek(0, io.SeekStart); err != nil {
		return ExpressionImage{}, fmt.Errorf("rewind image: %w", err)
	}
	img, err := decodeAndScale(src, p.Dim)
	if err != nil {
		return ExpressionImage{}, err
	}
	static, err := encodePNG(img)
	if err != nil {
		return ExpressionImage{}, err
	}
	return ExpressionImage{Static: static}, nil
}

func encodePNG(img image.Image) ([]byte, error) {
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, fmt.Errorf("encode png: %w", err)
	}
	return buf.Bytes(), nil
}

// processAnimatedExpression enforces the same screen and total-pixel
// budgets as processAnimatedGIF (before any pixel allocation), then decodes
// and renders every frame while holding an animatedSlots slot.
func processAnimatedExpression(ctx context.Context, src io.Reader, frames, screenW, screenH int, p ExpressionProfile) (ExpressionImage, error) {
	screenPixels := int64(screenW) * int64(screenH)
	if screenW <= 0 || screenH <= 0 || screenPixels > maxAnimatedScreenPixels {
		return ExpressionImage{}, fmt.Errorf("%w: animated %dx%d exceeds %d pixels",
			ErrImageTooLarge, screenW, screenH, maxAnimatedScreenPixels)
	}
	if int64(frames)*screenPixels > maxAnimatedTotalPixels {
		return ExpressionImage{}, fmt.Errorf("%w: %d frames of %dx%d exceed %d total pixels",
			ErrImageTooLarge, frames, screenW, screenH, maxAnimatedTotalPixels)
	}

	if err := ctx.Err(); err != nil {
		return ExpressionImage{}, fmt.Errorf("%w: %w", ErrImageBusy, err)
	}
	ctx, cancel := context.WithTimeout(ctx, animatedProcessTimeout)
	defer cancel()
	select {
	case animatedSlots <- struct{}{}:
	case <-ctx.Done():
		return ExpressionImage{}, fmt.Errorf("%w: %w", ErrImageBusy, ctx.Err())
	}
	defer func() { <-animatedSlots }()

	g, err := gif.DecodeAll(src)
	if err != nil {
		return ExpressionImage{}, fmt.Errorf("decode gif: %w", err)
	}
	// Same parity guard as processAnimatedGIF: refuse frames the budgets
	// never saw.
	if len(g.Image) != frames || len(g.Image) > maxAnimatedFrames {
		return ExpressionImage{}, fmt.Errorf("%w: decoder saw %d frames, scan saw %d",
			ErrTooManyFrames, len(g.Image), frames)
	}
	return renderAnimatedFit(ctx, g, p)
}

// renderAnimatedFit is renderAnimated's composite loop without the crop:
// every composited logical-screen canvas is BiLinear-scaled to fit p.Dim
// and quantised onto its source frame's palette; the poster is composited
// frame 0, CatmullRom-scaled to fit p.Dim and encoded as PNG. Delays and
// LoopCount are preserved; output frames use DisposalBackground.
func renderAnimatedFit(ctx context.Context, g *gif.GIF, p ExpressionProfile) (ExpressionImage, error) {
	screen := image.Rect(0, 0, g.Config.Width, g.Config.Height)
	canvas := image.NewRGBA(screen)

	out := &gif.GIF{LoopCount: g.LoopCount}
	var poster []byte

	for i, frame := range g.Image {
		if err := ctx.Err(); err != nil {
			return ExpressionImage{}, fmt.Errorf("%w: %w", ErrImageBusy, err)
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
			var err error
			if poster, err = encodePNG(cropScale(canvas, screen, p.Dim, draw.CatmullRom)); err != nil {
				return ExpressionImage{}, err
			}
		}

		scaled := cropScale(canvas, screen, p.Dim, draw.BiLinear)
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
		return ExpressionImage{}, fmt.Errorf("encode gif: %w", err)
	}
	if buf.Len() > p.MaxAnimatedOutput {
		return ExpressionImage{}, fmt.Errorf("%w: %d bytes exceeds %d",
			ErrAnimatedTooLarge, buf.Len(), p.MaxAnimatedOutput)
	}
	return ExpressionImage{Static: poster, Animated: buf.Bytes()}, nil
}
