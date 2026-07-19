// Package discovery — pure filter, rank, and tag policy for the public
// server directory (T4.4 foundation).
//
// The eventual GET /api/discovery/servers handler owns the DB query
// (repo layer) and the HTTP shape (handler layer). This package owns
// the middle: given a page of servers and a caller-supplied filter,
// which ones actually match, in what order, and how do we canonicalize
// the tag input on both sides of the request so a caller typing
// "Gaming, gaming " matches a server tagged "gaming"?
//
// Everything here is pure. That keeps the tests small and lets a
// future edit (add a "language" filter, tweak the rank formula)
// happen without dragging in a live DB.
package discovery

import (
	"sort"
	"strings"
	"time"
)

// Server is the minimum shape the filter needs. It's deliberately NOT
// models.Server — this package must not depend on the app model layer
// so unit tests don't need a whole model graph, and a future edit
// splitting the discovery row from the internal Server model won't
// require reworking the filter code.
type Server struct {
	ID          string
	Name        string
	Description string
	Tags        []string
	MemberCount int
	IsPublic    bool
	CreatedAt   time.Time
}

// Filter is the caller-supplied criteria for a discovery search.
// The zero value ("no query, no tags, no minimum members") returns
// every public server — matches the "browse everything" UX.
type Filter struct {
	// Query is a free-text search matched (case-insensitive) against
	// name and description. Empty query = "no name/description filter".
	Query string
	// Tags is the set of tags a server must ALL carry to match (AND
	// semantics). Empty slice = "no tag filter". Values are canonicalized
	// via NormalizeTag before comparison so callers don't have to.
	Tags []string
	// MinMembers is the smallest MemberCount that will match. Zero =
	// "no minimum" (default). Callers surface this as a "hide empty
	// servers" toggle in the UI.
	MinMembers int
}

// NormalizeTag returns the canonical form for equality comparison:
// trimmed, lowercased, with internal whitespace collapsed. Empty
// output means "not a valid tag" and the caller should drop it —
// blanks in the tag list would match every server.
func NormalizeTag(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	lower := strings.ToLower(trimmed)
	// Collapse runs of whitespace inside the tag ("indie   games" →
	// "indie games"). Multi-word tags are legit for discovery ("open
	// source", "türkçe topluluk") — we just want them consistent.
	fields := strings.Fields(lower)
	return strings.Join(fields, " ")
}

// ParseTagList canonicalizes and de-duplicates a raw tag input,
// preserving the caller's ordering after normalization. Used on both
// sides: the filter's Tags slice from the query string, and the
// server row's stored tag column. Silently drops empty entries so a
// trailing comma or a double-comma doesn't inject a wildcard.
func ParseTagList(raw string) []string {
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	seen := make(map[string]struct{}, len(parts))
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		norm := NormalizeTag(p)
		if norm == "" {
			continue
		}
		if _, dup := seen[norm]; dup {
			continue
		}
		seen[norm] = struct{}{}
		out = append(out, norm)
	}
	return out
}

// Match reports whether s satisfies every criterion in f. A server
// that is NOT IsPublic never matches — the discovery endpoint should
// filter at the SQL level too, but this belt-and-braces guarantee
// stops a caller-side bug from ever leaking a private server.
func Match(s Server, f Filter) bool {
	if !s.IsPublic {
		return false
	}
	if f.MinMembers > 0 && s.MemberCount < f.MinMembers {
		return false
	}
	if f.Query != "" {
		q := strings.ToLower(strings.TrimSpace(f.Query))
		if q != "" {
			name := strings.ToLower(s.Name)
			desc := strings.ToLower(s.Description)
			if !strings.Contains(name, q) && !strings.Contains(desc, q) {
				return false
			}
		}
	}
	if len(f.Tags) > 0 {
		serverTags := make(map[string]struct{}, len(s.Tags))
		for _, t := range s.Tags {
			if norm := NormalizeTag(t); norm != "" {
				serverTags[norm] = struct{}{}
			}
		}
		for _, want := range f.Tags {
			if _, ok := serverTags[NormalizeTag(want)]; !ok {
				return false
			}
		}
	}
	return true
}

// Rank orders a slice of servers for display. Larger member count
// wins; ties break on the more recent CreatedAt so newer communities
// aren't buried when they hit the same population as an older peer.
// Rank does NOT filter — call Match first, or the sort surfaces
// private servers to the top of "empty results".
//
// The input is not mutated; the returned slice is a fresh sort.
func Rank(servers []Server) []Server {
	out := make([]Server, len(servers))
	copy(out, servers)
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].MemberCount != out[j].MemberCount {
			return out[i].MemberCount > out[j].MemberCount
		}
		return out[i].CreatedAt.After(out[j].CreatedAt)
	})
	return out
}

// FilterAndRank is the composition callers most often want: keep the
// public+matching subset, then rank them. Provided here rather than in
// the handler so all three concerns (privacy floor, filter semantics,
// ordering) stay in one file that's easy to reason about.
func FilterAndRank(servers []Server, f Filter) []Server {
	matched := make([]Server, 0, len(servers))
	for _, s := range servers {
		if Match(s, f) {
			matched = append(matched, s)
		}
	}
	return Rank(matched)
}
