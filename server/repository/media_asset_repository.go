package repository

import (
	"context"
)

// MediaAssetRepository answers the "is this /api/uploads path a positively
// known public asset" question, independent of any attachment table. Media
// access authorization uses this as the fail-closed replacement for "no
// attachment table claimed this path, so serve it" — see
// services/media_access_service.go.
type MediaAssetRepository interface {
	// IsPublicAsset reports whether fileURL is referenced by a public-facing
	// media column (user avatar/wallpaper, server icon/banner). It does not
	// distinguish which column matched — callers only need the yes/no.
	IsPublicAsset(ctx context.Context, fileURL string) (bool, error)
}
