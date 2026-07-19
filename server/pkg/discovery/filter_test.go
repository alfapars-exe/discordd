package discovery

import (
	"reflect"
	"testing"
	"time"
)

// ─── Fixtures ───

// The clock never moves inside a test, so a fixed epoch keeps the
// CreatedAt values stable across parallel runs.
var epoch = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

func srv(id string, members int, tags ...string) Server {
	return Server{
		ID:          id,
		Name:        id,
		Description: "",
		Tags:        tags,
		MemberCount: members,
		IsPublic:    true,
		CreatedAt:   epoch,
	}
}

// ─── NormalizeTag ───

func TestNormalizeTag_trimAndLowercase(t *testing.T) {
	for _, tc := range []struct {
		in, want string
	}{
		{"Gaming", "gaming"},
		{"  gaming ", "gaming"},
		{"Türkçe Topluluk", "türkçe topluluk"},
		{"", ""},
		{"   ", ""}, // whitespace-only → empty
	} {
		if got := NormalizeTag(tc.in); got != tc.want {
			t.Errorf("NormalizeTag(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestNormalizeTag_collapsesInternalWhitespace(t *testing.T) {
	// Users type "indie   games" or paste tab-separated. The stored
	// value should be canonical so a filter matching "indie games"
	// hits both entry paths.
	if got := NormalizeTag("indie   games"); got != "indie games" {
		t.Errorf("collapse failed: got %q", got)
	}
	if got := NormalizeTag("indie\tgames"); got != "indie games" {
		t.Errorf("tab-separator: got %q", got)
	}
}

// ─── ParseTagList ───

func TestParseTagList_dedupAndCanonicalize(t *testing.T) {
	got := ParseTagList("Gaming, gaming ,indie, Indie ,")
	want := []string{"gaming", "indie"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("ParseTagList = %v, want %v", got, want)
	}
}

func TestParseTagList_emptyInputReturnsNil(t *testing.T) {
	// A nil slice (not an empty non-nil) so caller code doing
	// `len(tags) == 0` behaves the same as "filter absent".
	got := ParseTagList("")
	if got != nil {
		t.Errorf("empty input got %v, want nil", got)
	}
}

func TestParseTagList_dropsWildcardInjectionAttempts(t *testing.T) {
	// Trailing/double commas and whitespace-only entries would
	// otherwise inject an "empty tag" the Match logic treats as a
	// wildcard (or worse, matches nothing). Silently dropped.
	got := ParseTagList(",,,   ,,")
	if len(got) != 0 {
		t.Errorf("got %v, want empty from all-blank input", got)
	}
}

// ─── Match ───

func TestMatch_privateServerNeverMatchesEvenEmptyFilter(t *testing.T) {
	// Belt-and-braces: even if the caller passes no filter at all, a
	// server marked IsPublic=false must never leak into results.
	s := srv("private", 10)
	s.IsPublic = false
	if Match(s, Filter{}) {
		t.Fatal("private server leaked past Match")
	}
}

func TestMatch_publicServerMatchesEmptyFilter(t *testing.T) {
	if !Match(srv("public", 10), Filter{}) {
		t.Fatal("empty filter should accept all public servers")
	}
}

func TestMatch_queryHitsNameAndDescription(t *testing.T) {
	s := Server{
		ID: "s", Name: "Coding Club", Description: "For rustaceans",
		IsPublic: true,
	}
	// Name substring, case-insensitive.
	if !Match(s, Filter{Query: "coding"}) {
		t.Error("query 'coding' should hit name 'Coding Club'")
	}
	// Description substring, case-insensitive.
	if !Match(s, Filter{Query: "RUST"}) {
		t.Error("query 'RUST' should hit description 'For rustaceans'")
	}
	// Whitespace-only query treated as "no query", not "match empty".
	if !Match(s, Filter{Query: "   "}) {
		t.Error("whitespace-only query should be treated as no query")
	}
}

func TestMatch_queryMisses(t *testing.T) {
	s := Server{ID: "s", Name: "chess", Description: "8x8", IsPublic: true}
	if Match(s, Filter{Query: "backgammon"}) {
		t.Error("unrelated query should not match")
	}
}

func TestMatch_minMembersEnforced(t *testing.T) {
	tiny := srv("tiny", 3)
	big := srv("big", 100)
	if Match(tiny, Filter{MinMembers: 10}) {
		t.Error("tiny server matched despite MinMembers=10")
	}
	if !Match(big, Filter{MinMembers: 10}) {
		t.Error("big server excluded by MinMembers=10")
	}
	// Zero MinMembers = no floor.
	if !Match(tiny, Filter{MinMembers: 0}) {
		t.Error("MinMembers=0 should be no floor")
	}
}

func TestMatch_tagsUseANDSemantics(t *testing.T) {
	// A filter carrying multiple tags matches only servers carrying
	// ALL of them. OR semantics would mean "add a tag = get more
	// results", which is the wrong shape for a "narrow down" UX.
	s := srv("s", 10, "gaming", "indie", "türkçe")
	if !Match(s, Filter{Tags: []string{"gaming", "indie"}}) {
		t.Error("server with gaming+indie must match filter {gaming, indie}")
	}
	if Match(s, Filter{Tags: []string{"gaming", "sports"}}) {
		t.Error("server missing 'sports' must not match {gaming, sports}")
	}
}

func TestMatch_tagCasingIsFoldedOnBothSides(t *testing.T) {
	// Server row stored "GAMING"; filter typed "gaming". Both should
	// canonicalize to the same key.
	s := srv("s", 10, "GAMING")
	if !Match(s, Filter{Tags: []string{"gaming"}}) {
		t.Error("server tag 'GAMING' should match filter 'gaming'")
	}
}

// ─── Rank ───

func TestRank_memberCountDescending(t *testing.T) {
	in := []Server{srv("a", 1), srv("b", 100), srv("c", 50)}
	got := Rank(in)
	wantOrder := []string{"b", "c", "a"}
	for i, w := range wantOrder {
		if got[i].ID != w {
			t.Errorf("Rank pos %d = %q, want %q (whole order: %v)", i, got[i].ID, w, ids(got))
		}
	}
}

func TestRank_tiesBreakOnCreatedAtRecency(t *testing.T) {
	// Two servers at 50 members — the newer CreatedAt should surface
	// first so new communities aren't buried alongside older peers.
	older := Server{ID: "older", MemberCount: 50, IsPublic: true, CreatedAt: epoch}
	newer := Server{ID: "newer", MemberCount: 50, IsPublic: true, CreatedAt: epoch.Add(24 * time.Hour)}
	got := Rank([]Server{older, newer})
	if got[0].ID != "newer" || got[1].ID != "older" {
		t.Errorf("tie order = %v, want [newer older]", ids(got))
	}
}

func TestRank_isPure_doesNotMutateInput(t *testing.T) {
	// The caller may hold a reference to the pre-rank list for logging
	// or metrics; the sort must not shuffle it under them.
	in := []Server{srv("a", 1), srv("b", 100)}
	inSnapshot := append([]Server(nil), in...)
	_ = Rank(in)
	if !reflect.DeepEqual(in, inSnapshot) {
		t.Errorf("Rank mutated its input: after=%v, before=%v", ids(in), ids(inSnapshot))
	}
}

// ─── FilterAndRank ───

func TestFilterAndRank_endToEndCombinesPrivacyFilterAndOrder(t *testing.T) {
	private := srv("private", 500)
	private.IsPublic = false
	pool := []Server{
		private,                // dropped by privacy floor
		srv("tiny", 3),         // dropped by MinMembers
		srv("mid", 25, "coding"),
		srv("big", 100, "coding"),
		srv("off-topic", 200, "cooking"),
	}
	got := FilterAndRank(pool, Filter{
		MinMembers: 10,
		Tags:       []string{"coding"},
	})
	wantIDs := []string{"big", "mid"}
	gotIDs := ids(got)
	if !reflect.DeepEqual(gotIDs, wantIDs) {
		t.Errorf("FilterAndRank end-to-end = %v, want %v", gotIDs, wantIDs)
	}
}

func TestFilterAndRank_emptyPoolReturnsEmptySlice(t *testing.T) {
	got := FilterAndRank(nil, Filter{})
	if len(got) != 0 {
		t.Errorf("empty in → %v, want empty out", got)
	}
}

// ─── helpers ───

func ids(ss []Server) []string {
	out := make([]string, len(ss))
	for i, s := range ss {
		out[i] = s.ID
	}
	return out
}
