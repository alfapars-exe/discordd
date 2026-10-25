// Package handlers — image_banner.go: the profile-banner pipeline.
//
// Every banner gets a static poster. Multi-frame GIF input also gets a
// bounded re-encoded animation; APNG remains poster-only and animated WebP
// is rejected explicitly.
package handlers

import (
	"bytes"
	"context"
	"fmt"
	"image"
	stddraw "image/draw"
	"image/gif"
	"io"

	xdraw "golang.org/x/image/draw"
)

const (
	bannerAspectW = 5
	bannerAspectH = 2
	// bannerMaxW caps the crop's width — its longest edge — so the output
	// is at most 1200×480.
	bannerMaxW         = 1200
	animatedBannerMaxW = 600
)

func ProcessBanner(ctx context.Context, src io.ReadSeeker) (AvatarResult, error) {
	head, err := readHead(src)
	if err != nil {
		return AvatarResult{}, err
	}
	if IsAnimatedWebP(head) {
		return AvatarResult{}, ErrAnimatedWebPUnsupported
	}
	if bytes.HasPrefix(head, []byte("GIF8")) {
		frames, w, h, err := ScanGIF(src, maxAnimatedFrames)
		if err != nil {
			return AvatarResult{}, err
		}
		if _, err := src.Seek(0, io.SeekStart); err != nil {
			return AvatarResult{}, err
		}
		if frames >= 2 {
			return processAnimatedBannerGIF(ctx, src, frames, w, h)
		}
	}
	static, ext, err := ResizeBannerBytes(src)
	return AvatarResult{Static: static, StaticExt: ext}, err
}

func processAnimatedBannerGIF(ctx context.Context, src io.Reader, frames, screenW, screenH int) (AvatarResult, error) {
	pixels := int64(screenW) * int64(screenH)
	if screenW <= 0 || screenH <= 0 || pixels > maxAnimatedScreenPixels || int64(frames)*pixels > maxAnimatedTotalPixels {
		return AvatarResult{}, ErrImageTooLarge
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
	if len(g.Image) != frames || len(g.Image) > maxAnimatedFrames {
		return AvatarResult{}, ErrTooManyFrames
	}
	return renderAnimatedBanner(ctx, g)
}

func renderAnimatedBanner(ctx context.Context, g *gif.GIF) (AvatarResult, error) {
	screen := image.Rect(0, 0, g.Config.Width, g.Config.Height)
	canvas := image.NewRGBA(screen)
	crop := centerCropAspect(screen, bannerAspectW, bannerAspectH)
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
		stddraw.Draw(canvas, frame.Bounds(), frame, frame.Bounds().Min, stddraw.Over)
		if i == 0 {
			p := cropScale(canvas, crop, bannerMaxW, xdraw.CatmullRom)
			var err error
			poster, posterExt, err = encodeStatic(p)
			if err != nil {
				return AvatarResult{}, err
			}
		}
		scaled := cropScale(canvas, crop, animatedBannerMaxW, xdraw.BiLinear)
		out.Image = append(out.Image, quantizeFrame(scaled, frame.Palette))
		delay := 0
		if i < len(g.Delay) {
			delay = g.Delay[i]
		}
		out.Delay = append(out.Delay, delay)
		out.Disposal = append(out.Disposal, gif.DisposalBackground)
		switch disposal {
		case gif.DisposalBackground:
			stddraw.Draw(canvas, frame.Bounds(), image.Transparent, image.Point{}, stddraw.Src)
		case gif.DisposalPrevious:
			canvas = saved
		}
	}
	var buf bytes.Buffer
	if err := gif.EncodeAll(&buf, out); err != nil {
		return AvatarResult{}, fmt.Errorf("encode gif: %w", err)
	}
	if buf.Len() > maxAnimatedOutputBytes {
		return AvatarResult{}, fmt.Errorf("%w: %d bytes exceeds %d", ErrAnimatedTooLarge, buf.Len(), maxAnimatedOutputBytes)
	}
	return AvatarResult{Static: poster, StaticExt: posterExt, Animated: buf.Bytes()}, nil
}

// ResizeBannerBytes decodes src (jpeg / png / gif / webp still), applies the
// 5:2 cover crop and the bannerMaxW cap, and returns the encoded bytes plus
// the extension to use on disk (".png" when translucent, else ".jpg").
// Uses the same bomb guard as ResizeAvatarBytes: DecodeConfig → pixel cap →
// Seek(0) → full decode inside a decodeSlots slot.
func ResizeBannerBytes(src io.ReadSeeker) ([]byte, string, error) {
	head, err := readHead(src)
	if err != nil {
		return nil, "", err
	}
	if IsAnimatedWebP(head) {
		return nil, "", ErrAnimatedWebPUnsupported
	}

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

	banner, err := decodeBanner(src)
	if err != nil {
		return nil, "", err
	}
	return encodeStatic(banner)
}

// decodeBanner holds a decodeSlots slot for the decode + crop + scale.
// The 5:2 crop's width is always its longest edge, so capping it at
// bannerMaxW also caps the height at 480.
func decodeBanner(src io.Reader) (*image.RGBA, error) {
	decodeSlots <- struct{}{}
	defer func() { <-decodeSlots }()

	img, _, err := image.Decode(src)
	if err != nil {
		return nil, fmt.Errorf("decode image: %w", err)
	}
	crop := centerCropAspect(img.Bounds(), bannerAspectW, bannerAspectH)
	return cropScale(img, crop, bannerMaxW, xdraw.CatmullRom), nil
}
