package pkg

import (
	"math"
	"net/http"
	"strconv"
)

// ClampInt parses s as an int and clamps it into [min, max], falling back
// to def when s is empty or unparseable. Shared by every handler that reads
// a user-supplied page-size/page-number query parameter, so the same
// clamp logic isn't reimplemented (and isn't allowed to silently drift)
// per call site — see handlers/gif.go's Trending/Search (per_page/page),
// handlers/search.go and handlers/feedback.go's ClampPagination callers
// (limit/offset) below.
func ClampInt(s string, def, min, max int) int {
	if s == "" {
		return def
	}
	v, err := strconv.Atoi(s)
	if err != nil {
		return def
	}
	if v < min {
		return min
	}
	if v > max {
		return max
	}
	return v
}

// ClampPagination reads the "limit" and "offset" query parameters from r.
// A zero/negative limit falls back to defLimit rather than clamping to 1 —
// the original per-handler parsers guarded assignment with `n > 0`, so
// anything non-positive kept the default; only above-ceiling values clamp
// down to maxLimit. Offset clamps to a non-negative value (falling back to
// 0, no upper bound — no existing call site capped offset).
func ClampPagination(r *http.Request, defLimit, maxLimit int) (limit, offset int) {
	limit = defLimit
	if s := r.URL.Query().Get("limit"); s != "" {
		if v, err := strconv.Atoi(s); err == nil && v > 0 {
			limit = v
			if limit > maxLimit {
				limit = maxLimit
			}
		}
	}
	offset = ClampInt(r.URL.Query().Get("offset"), 0, 0, math.MaxInt)
	return limit, offset
}
