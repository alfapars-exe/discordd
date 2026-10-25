package handlers

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"testing"
)

func bannerDims(t *testing.T, src []byte) (int, int, string) {
	t.Helper()
	out, ext, err := ResizeBannerBytes(bytes.NewReader(src))
	if err != nil {
		t.Fatalf("ResizeBannerBytes: %v", err)
	}
	img, _, err := image.Decode(bytes.NewReader(out))
	if err != nil {
		t.Fatalf("decode banner output: %v", err)
	}
	return img.Bounds().Dx(), img.Bounds().Dy(), ext
}

// TestResizeBannerBytes_CropNoUpscale — 2000×400 is wider than 5:2, so the
// cover crop keeps the full height (1000×400) and is not scaled up to 1200.
func TestResizeBannerBytes_CropNoUpscale(t *testing.T) {
	src := encodePNGFixture(t, newSolidRGBA(2000, 400, color.RGBA{10, 20, 30, 0xff}))
	w, h, ext := bannerDims(t, src)
	if w != 1000 || h != 400 {
		t.Errorf("dims = %dx%d, want 1000x400", w, h)
	}
	if ext != ".jpg" {
		t.Errorf("ext = %q, want .jpg for an opaque source", ext)
	}
}

// TestResizeBannerBytes_ScaleDown — 3000×1200 is exactly 5:2 and scales to
// the 1200×480 cap.
func TestResizeBannerBytes_ScaleDown(t *testing.T) {
	src := encodePNGFixture(t, newSolidRGBA(3000, 1200, color.RGBA{0, 0, 0xff, 0x80}))
	w, h, ext := bannerDims(t, src)
	if w != 1200 || h != 480 {
		t.Errorf("dims = %dx%d, want 1200x480", w, h)
	}
	if ext != ".png" {
		t.Errorf("ext = %q, want .png for a translucent source", ext)
	}
}

// TestResizeBannerBytes_TallSourceCropsHeight — a portrait source keeps its
// width and loses top/bottom.
func TestResizeBannerBytes_TallSourceCropsHeight(t *testing.T) {
	src := encodePNGFixture(t, newSolidRGBA(500, 900, color.RGBA{1, 2, 3, 0xff}))
	w, h, _ := bannerDims(t, src)
	if w != 500 || h != 200 {
		t.Errorf("dims = %dx%d, want 500x200", w, h)
	}
}

// TestResizeBannerBytes_AnimatedGIFUsesFirstFrame — banners are static; an
// animated GIF is accepted and flattened to frame 0.
func TestResizeBannerBytes_AnimatedGIFUsesFirstFrame(t *testing.T) {
	src := buildTestGIF(t, 3, 500, 200, false, nil, 0)
	w, h, _ := bannerDims(t, src)
	if w != 500 || h != 200 {
		t.Errorf("dims = %dx%d, want 500x200", w, h)
	}
}

func TestProcessBanner_AnimatedGIFReturnsPosterAndBoundedAnimation(t *testing.T) {
	src := buildTestGIF(t, 3, 1000, 400, false, nil, 0)
	result, err := ProcessBanner(context.Background(), bytes.NewReader(src))
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Static) == 0 || len(result.Animated) == 0 {
		t.Fatal("missing poster or animation")
	}
	poster, _, err := image.Decode(bytes.NewReader(result.Static))
	if err != nil {
		t.Fatal(err)
	}
	if poster.Bounds().Dx() != 1000 || poster.Bounds().Dy() != 400 {
		t.Fatalf("poster=%v", poster.Bounds())
	}
	animated, _, err := image.Decode(bytes.NewReader(result.Animated))
	if err != nil {
		t.Fatal(err)
	}
	if animated.Bounds().Dx() != animatedBannerMaxW || animated.Bounds().Dy() != animatedBannerMaxW*bannerAspectH/bannerAspectW {
		t.Fatalf("animation=%v", animated.Bounds())
	}
}

func TestResizeBannerBytes_RejectsDecodeBomb(t *testing.T) {
	_, _, err := ResizeBannerBytes(bytes.NewReader(buildTruncatedPNGBomb(30000, 30000)))
	if !errors.Is(err, ErrImageTooLarge) {
		t.Fatalf("err = %v, want ErrImageTooLarge", err)
	}
}

func TestResizeBannerBytes_RejectsUnregisteredFormat(t *testing.T) {
	bmp := append([]byte("BM"), make([]byte, 52)...)
	_, _, err := ResizeBannerBytes(bytes.NewReader(bmp))
	if err == nil {
		t.Fatal("expected an error for an unregistered BMP format, got nil")
	}
	if errors.Is(err, ErrImageTooLarge) {
		t.Fatal("BMP fixture should fail on unknown format, not the pixel-size guard")
	}
}

func TestResizeBannerBytes_RejectsAnimatedWebP(t *testing.T) {
	_, _, err := ResizeBannerBytes(bytes.NewReader(animatedWebPHeader(0x02)))
	if !errors.Is(err, ErrAnimatedWebPUnsupported) {
		t.Fatalf("err = %v, want ErrAnimatedWebPUnsupported", err)
	}
}
