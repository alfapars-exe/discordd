package pkg

import (
	"net/http"
	"net/url"
	"testing"
)

func TestClampInt(t *testing.T) {
	tests := []struct {
		name string
		s    string
		def  int
		min  int
		max  int
		want int
	}{
		{"empty string uses default", "", 20, 1, 100, 20},
		{"unparseable uses default", "not-a-number", 20, 1, 100, 20},
		{"within range passes through", "50", 20, 1, 100, 50},
		{"below min clamps to min", "0", 20, 1, 100, 1},
		{"negative clamps to min", "-5", 20, 1, 100, 1},
		{"above max clamps to max", "500", 20, 1, 100, 100},
		{"exactly min is accepted", "1", 20, 1, 100, 1},
		{"exactly max is accepted", "100", 20, 1, 100, 100},
		{"different min/max (gif per_page shape)", "3", 24, 8, 50, 8},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := ClampInt(tc.s, tc.def, tc.min, tc.max)
			if got != tc.want {
				t.Errorf("ClampInt(%q, %d, %d, %d) = %d, want %d", tc.s, tc.def, tc.min, tc.max, got, tc.want)
			}
		})
	}
}

// requestWithQuery builds a GET request carrying the given raw query string,
// for exercising ClampPagination's r.URL.Query() reads.
func requestWithQuery(t *testing.T, rawQuery string) *http.Request {
	t.Helper()
	u := &url.URL{Path: "/api/x", RawQuery: rawQuery}
	return &http.Request{Method: http.MethodGet, URL: u}
}

func TestClampPagination(t *testing.T) {
	tests := []struct {
		name       string
		rawQuery   string
		defLimit   int
		maxLimit   int
		wantLimit  int
		wantOffset int
	}{
		{"no params uses defaults", "", 20, 100, 20, 0},
		{"limit within range", "limit=50", 20, 100, 50, 0},
		{"limit above max clamps", "limit=500", 20, 100, 100, 0},
		{"limit zero or negative falls back to default (min 1)", "limit=0", 20, 100, 20, 0},
		{"limit negative falls back to default", "limit=-5", 20, 100, 20, 0},
		{"offset within range", "offset=40", 20, 100, 20, 40},
		{"negative offset falls back to 0", "offset=-1", 20, 100, 20, 0},
		{"offset has no upper bound", "offset=1000000", 20, 100, 20, 1000000},
		{"both limit and offset set", "limit=10&offset=30", 20, 100, 10, 30},
		{"unparseable limit falls back to default", "limit=abc", 20, 100, 20, 0},
		{"search.go shape (default 25, max 100)", "limit=25", 25, 100, 25, 0},
		{"feedback.go shape (default 20, max 100)", "", 20, 100, 20, 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := requestWithQuery(t, tc.rawQuery)
			gotLimit, gotOffset := ClampPagination(r, tc.defLimit, tc.maxLimit)
			if gotLimit != tc.wantLimit {
				t.Errorf("limit = %d, want %d", gotLimit, tc.wantLimit)
			}
			if gotOffset != tc.wantOffset {
				t.Errorf("offset = %d, want %d", gotOffset, tc.wantOffset)
			}
		})
	}
}

// TestClampPagination_PreservesExistingCallSiteDefaults pins the exact
// default/ceiling pairs the three real call sites use (P1.13) — a change to
// any of these constants at the call site is a deliberate product decision,
// not an accidental drift introduced by the shared helper.
func TestClampPagination_PreservesExistingCallSiteDefaults(t *testing.T) {
	cases := []struct {
		site     string
		defLimit int
		maxLimit int
	}{
		{"handlers/feedback.go (AdminListTickets / ListMyTickets)", 20, 100},
		{"handlers/search.go (Search)", 25, 100},
	}
	for _, c := range cases {
		t.Run(c.site, func(t *testing.T) {
			r := requestWithQuery(t, "")
			limit, offset := ClampPagination(r, c.defLimit, c.maxLimit)
			if limit != c.defLimit {
				t.Errorf("default limit = %d, want %d", limit, c.defLimit)
			}
			if offset != 0 {
				t.Errorf("default offset = %d, want 0", offset)
			}

			rMax := requestWithQuery(t, "limit=999999")
			limitMax, _ := ClampPagination(rMax, c.defLimit, c.maxLimit)
			if limitMax != c.maxLimit {
				t.Errorf("clamped limit = %d, want ceiling %d", limitMax, c.maxLimit)
			}
		})
	}
}
