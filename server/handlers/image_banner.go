// Package handlers — image_banner.go: the profile-banner pipeline.
//
// Banners are static only: a GIF contributes its first frame and an APNG its
// default image (that is what image.Decode returns for both). The decoded
// image is centre-cropped to 5:2 ("cover", the same framing the client
// preview gets from object-fit: cover; object-position: center), scaled
// down to at most 1200×480 (never up), and re-encoded by
// encodeStatic, so the bytes on disk are always encoder output (K-021).
package handlers

import (
	"fmt"
	"image"
	"io"

	"golang.org/x/image/draw"
)

const (
	bannerAspectW = 5
	bannerAspectH = 2
	// bannerMaxW caps the crop's width — its longest edge — so the output
	// is at most 1200×480.
	bannerMaxW = 1200
)

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
	return cropScale(img, crop, bannerMaxW, draw.CatmullRom), nil
}
