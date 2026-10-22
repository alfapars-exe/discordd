package models

import (
	"errors"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/pkg"
)

// TestSlugifyExpressionName pins the shared Go/TS vectors (Sözleşme §5);
// client/src/utils/expressionTokens.test.ts carries the same table.
func TestSlugifyExpressionName(t *testing.T) {
	tests := []struct {
		in   string
		want string // "" = invalid
	}{
		{"Şaşkın Kedi", "saskin_kedi"},
		{"İyi Günler!", "iyi_gunler"},
		{"ÇOK-ÖZEL", "cok_ozel"},
		{"  a  ", ""},
		{"__x__", ""},
		{"🐱cat", "cat"},
		{"ab", "ab"},
		{"a.b-c d", "a_b_c_d"},
		{"abcdefghijklmnopqrstuvwxyz_0123456789", "abcdefghijklmnopqrstuvwxyz_01234"},
		{"x___y", "x_y"},
		// Tab / CR / LF map to '_' like a space (TS parity); other Unicode
		// spaces (NBSP) are simply dropped.
		{"a\tb", "a_b"},
		{"a\rb", "a_b"},
		{"a\nb", "a_b"},
		{"a\r\nb", "a_b"},
		{"a b", "ab"},
	}
	for _, tt := range tests {
		got, ok := SlugifyExpressionName(tt.in)
		if tt.want == "" {
			if ok {
				t.Errorf("SlugifyExpressionName(%q) = %q, want invalid", tt.in, got)
			}
			continue
		}
		if !ok || got != tt.want {
			t.Errorf("SlugifyExpressionName(%q) = (%q, %v), want %q", tt.in, got, ok, tt.want)
		}
	}
}

func TestSlugifyExpressionName_TrimsAfterCut(t *testing.T) {
	// 31 letters then "_b": the cut at 32 leaves a trailing '_' to trim.
	in := strings.Repeat("a", 31) + " b"
	got, ok := SlugifyExpressionName(in)
	if !ok || got != strings.Repeat("a", 31) {
		t.Errorf("got (%q, %v), want 31 a's", got, ok)
	}
}

func TestCreateEmojiRequest_Validate(t *testing.T) {
	r := CreateEmojiRequest{DisplayName: "  Şaşkın Kedi  "}
	if err := r.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if r.DisplayName != "Şaşkın Kedi" || r.Name != "saskin_kedi" {
		t.Errorf("normalised = (%q, %q)", r.DisplayName, r.Name)
	}

	explicit := CreateEmojiRequest{DisplayName: "Kedi", Name: " kedi_2 "}
	if err := explicit.Validate(); err != nil || explicit.Name != "kedi_2" {
		t.Errorf("explicit name: err=%v name=%q", err, explicit.Name)
	}

	for _, bad := range []CreateEmojiRequest{
		{DisplayName: "Kedi", Name: "Kedi"},  // upper case is not a slug
		{DisplayName: "Kedi", Name: "a"},     // too short
		{DisplayName: "Kedi", Name: "ke di"}, // space
		{DisplayName: "!"},                   // derives to nothing
	} {
		if err := bad.Validate(); !errors.Is(err, ErrExpressionNameInvalid) {
			t.Errorf("Validate(%+v) = %v, want ErrExpressionNameInvalid", bad, err)
		}
	}

	for _, dn := range []string{"", "   ", "evil‮eman", strings.Repeat("ş", 33)} {
		r := CreateEmojiRequest{DisplayName: dn, Name: "ok_name"}
		if err := r.Validate(); !errors.Is(err, ErrExpressionDisplayNameInvalid) {
			t.Errorf("display_name %q: err = %v, want ErrExpressionDisplayNameInvalid", dn, err)
		}
	}
	ok32 := CreateEmojiRequest{DisplayName: strings.Repeat("ş", 32), Name: "ok_name"}
	if err := ok32.Validate(); err != nil {
		t.Errorf("32-rune display_name rejected: %v", err)
	}
}

func TestUpdateEmojiRequest_Validate(t *testing.T) {
	if err := (&UpdateEmojiRequest{}).Validate(); !errors.Is(err, ErrExpressionNoChanges) {
		t.Errorf("empty patch: %v", err)
	}
	copyable := true
	if err := (&UpdateEmojiRequest{Copyable: &copyable}).Validate(); err != nil {
		t.Errorf("copyable-only patch: %v", err)
	}
	bad := "Bad Name"
	if err := (&UpdateEmojiRequest{Name: &bad}).Validate(); !errors.Is(err, ErrExpressionNameInvalid) {
		t.Errorf("bad name: %v", err)
	}
	dn := " Yeni Ad "
	r := UpdateEmojiRequest{DisplayName: &dn}
	if err := r.Validate(); err != nil || *r.DisplayName != "Yeni Ad" {
		t.Errorf("display_name: err=%v value=%q", err, *r.DisplayName)
	}
}

func TestExpressionErrors_MapToStatusSentinels(t *testing.T) {
	cases := map[error]error{
		ErrExpressionNameInvalid:        pkg.ErrBadRequest,
		ErrExpressionDisplayNameInvalid: pkg.ErrBadRequest,
		ErrExpressionNameTaken:          pkg.ErrAlreadyExists,
		ErrExpressionLimitReached:       pkg.ErrBadRequest,
		ErrExpressionLicenseCreatorOnly: pkg.ErrForbidden,
		ErrUnknownEmoji:                 pkg.ErrBadRequest,
	}
	for err, sentinel := range cases {
		if !errors.Is(err, sentinel) {
			t.Errorf("%v does not wrap %v", err, sentinel)
		}
	}
}

func TestParseReactionEmoji(t *testing.T) {
	type want struct {
		custom   bool
		id       string
		animated bool
		ok       bool
	}
	tests := []struct {
		in   string
		want want
	}{
		{"👍", want{ok: true}},
		{"👨‍👩‍👧", want{ok: true}}, // ZWJ family: Cf, must pass
		{"  👍  ", want{ok: true}},
		{"❤️", want{ok: true}}, // VS16
		{"🇹🇷", want{ok: true}}, // flag (regional indicators)
		{"🏴\U000E0067\U000E0062\U000E0073\U000E0063\U000E0074\U000E007F", want{ok: true}}, // tag-sequence flag
		{"👩‍❤️‍👨", want{ok: true}},                                                        // ZWJ + VS16
		{"👍‮", want{}},
		{"‪👍", want{}},
		{"👍⁦", want{}},
		{"👍⁩", want{}},
		{"👍‎", want{}},
		{"👍‏", want{}},
		{"👍؜", want{}},
		{strings.Repeat("a", 32), want{ok: true}},
		{strings.Repeat("a", 33), want{}},
		{"<:0123456789abcdef>", want{custom: true, id: "0123456789abcdef", ok: true}},
		{"<a:0123456789abcdef>", want{custom: true, id: "0123456789abcdef", animated: true, ok: true}},
		{"<:kedi:0123456789abcdef>", want{}}, // content-token form is not a reaction key
		{"<:0123456789abcdeg>", want{}},
		{"<:0123456789ABCDEF>", want{}},
		{"<script>", want{}},
		{"a\u0000", want{}},
		{"\n", want{}},
		{"", want{}},
		{"\xff", want{}},
	}
	for _, tt := range tests {
		custom, id, animated, err := ParseReactionEmoji(tt.in)
		if (err == nil) != tt.want.ok {
			t.Errorf("ParseReactionEmoji(%q) err = %v, want ok=%v", tt.in, err, tt.want.ok)
			continue
		}
		if err != nil {
			if !errors.Is(err, pkg.ErrBadRequest) {
				t.Errorf("ParseReactionEmoji(%q) err %v does not wrap ErrBadRequest", tt.in, err)
			}
			continue
		}
		if custom != tt.want.custom || id != tt.want.id || animated != tt.want.animated {
			t.Errorf("ParseReactionEmoji(%q) = (%v, %q, %v), want (%v, %q, %v)",
				tt.in, custom, id, animated, tt.want.custom, tt.want.id, tt.want.animated)
		}
	}

	if _, _, _, err := ParseReactionEmoji(strings.Repeat("a", 33)); err == nil || err.Error() != "bad request: emoji too long" {
		t.Errorf("33 runes: err = %v, want the legacy 'emoji too long' text", err)
	}
	if _, _, _, err := ParseReactionEmoji(""); err == nil || err.Error() != "bad request: emoji is required" {
		t.Errorf("empty: err = %v, want the legacy 'emoji is required' text", err)
	}
}

func TestReactionKeyForCustomEmoji(t *testing.T) {
	if got := ReactionKeyForCustomEmoji("0123456789abcdef", false); got != "<:0123456789abcdef>" {
		t.Errorf("static key = %q", got)
	}
	if got := ReactionKeyForCustomEmoji("0123456789abcdef", true); got != "<a:0123456789abcdef>" {
		t.Errorf("animated key = %q", got)
	}
}
