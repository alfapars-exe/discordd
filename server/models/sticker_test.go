package models

import (
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/pkg"
)

// TestNormalizeStickerTags pins the shared Go/TS vectors (Sözleşme §6); the
// client's normalizeStickerTags test carries the same table.
func TestNormalizeStickerTags(t *testing.T) {
	tests := []struct {
		name string
		in   []string
		want []string // nil = invalid
	}{
		{"trim and case-insensitive dedupe", []string{"kedi", " Kedi ", "köpek"}, []string{"kedi", "köpek"}},
		{"blank entries skipped", []string{"", " "}, []string{}},
		{"nil input", nil, []string{}},
		{"comma rejected", []string{"a,b"}, nil},
		{"six distinct rejected", []string{"a", "b", "c", "d", "e", "f"}, nil},
		{"five distinct allowed", []string{"a", "b", "c", "d", "e"}, []string{"a", "b", "c", "d", "e"}},
		{"duplicates do not count toward the cap", []string{"a", "A", "b", "c", "d", "e"}, []string{"a", "b", "c", "d", "e"}},
		{"21 runes rejected", []string{strings.Repeat("x", 21)}, nil},
		{"20 runes allowed", []string{strings.Repeat("ş", 20)}, []string{strings.Repeat("ş", 20)}},
		{"bidi override rejected", []string{"‮ab"}, nil},
		{"newline rejected", []string{"a\nb"}, nil},
		{"Turkish dotted case folds", []string{"Şeker", "şeker"}, []string{"Şeker"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := NormalizeStickerTags(tc.in)
			if tc.want == nil {
				if !errors.Is(err, ErrExpressionTagsInvalid) {
					t.Fatalf("NormalizeStickerTags(%q) = %q, %v — want ErrExpressionTagsInvalid", tc.in, got, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("NormalizeStickerTags(%q): %v", tc.in, err)
			}
			if got == nil || !slices.Equal(got, tc.want) {
				t.Errorf("NormalizeStickerTags(%q) = %#v, want %#v", tc.in, got, tc.want)
			}
		})
	}
}

func TestCreateStickerRequest_Validate(t *testing.T) {
	r := &CreateStickerRequest{DisplayName: "  Mutlu Kedi ", Description: "  bir kedi  ", Tags: []string{" kedi ", "Kedi"}}
	if err := r.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if r.Name != "mutlu_kedi" || r.DisplayName != "Mutlu Kedi" || r.Description != "bir kedi" || !slices.Equal(r.Tags, []string{"kedi"}) {
		t.Errorf("normalised = %+v", r)
	}

	empty := &CreateStickerRequest{DisplayName: "Kedi"}
	if err := empty.Validate(); err != nil || empty.Tags == nil || len(empty.Tags) != 0 || empty.Description != "" {
		t.Errorf("no tags/description: %+v, %v — want Tags = [] and Description = \"\"", empty, err)
	}

	cases := []struct {
		name string
		req  CreateStickerRequest
		want error
	}{
		{"empty display name", CreateStickerRequest{DisplayName: "  "}, ErrExpressionDisplayNameInvalid},
		{"33 rune display name", CreateStickerRequest{DisplayName: strings.Repeat("a", 33)}, ErrExpressionDisplayNameInvalid},
		{"bidi display name", CreateStickerRequest{DisplayName: "evil‮"}, ErrExpressionDisplayNameInvalid},
		{"bad explicit name", CreateStickerRequest{DisplayName: "Kedi", Name: "Bad Name"}, ErrExpressionNameInvalid},
		{"unsluggable display name", CreateStickerRequest{DisplayName: "!!"}, ErrExpressionNameInvalid},
		{"101 rune description", CreateStickerRequest{DisplayName: "Kedi", Description: strings.Repeat("ç", 101)}, ErrExpressionDescriptionInvalid},
		{"multi-line description", CreateStickerRequest{DisplayName: "Kedi", Description: "bir\niki"}, ErrExpressionDescriptionInvalid},
		{"bidi description", CreateStickerRequest{DisplayName: "Kedi", Description: "a‮b"}, ErrExpressionDescriptionInvalid},
		{"bad tag", CreateStickerRequest{DisplayName: "Kedi", Tags: []string{"a,b"}}, ErrExpressionTagsInvalid},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := tc.req
			if err := req.Validate(); !errors.Is(err, tc.want) {
				t.Errorf("Validate() = %v, want %v", err, tc.want)
			}
		})
	}

	ok := &CreateStickerRequest{DisplayName: "Kedi", Description: strings.Repeat("ç", 100)}
	if err := ok.Validate(); err != nil {
		t.Errorf("100 rune description: %v", err)
	}
}

func TestUpdateStickerRequest_Validate(t *testing.T) {
	if err := (&UpdateStickerRequest{}).Validate(); !errors.Is(err, ErrExpressionNoChanges) {
		t.Errorf("empty PATCH: %v", err)
	}
	tags := []string{" a ", "A", "b"}
	desc := "  açıklama "
	r := &UpdateStickerRequest{Tags: &tags, Description: &desc}
	if err := r.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if !slices.Equal(*r.Tags, []string{"a", "b"}) || *r.Description != "açıklama" {
		t.Errorf("normalised = tags %q, description %q", *r.Tags, *r.Description)
	}
	cleared := []string{}
	if err := (&UpdateStickerRequest{Tags: &cleared}).Validate(); err != nil {
		t.Errorf("clearing tags: %v", err)
	}
	bad := "x\ny"
	if err := (&UpdateStickerRequest{Description: &bad}).Validate(); !errors.Is(err, ErrExpressionDescriptionInvalid) {
		t.Errorf("bad description: %v", err)
	}
	badName := "A"
	if err := (&UpdateStickerRequest{Name: &badName}).Validate(); !errors.Is(err, ErrExpressionNameInvalid) {
		t.Errorf("bad name: %v", err)
	}
}

func TestStickerAndCloneErrors_MapToStatusSentinels(t *testing.T) {
	cases := []struct {
		err, sentinel error
	}{
		{ErrExpressionDescriptionInvalid, pkg.ErrBadRequest},
		{ErrExpressionTagsInvalid, pkg.ErrBadRequest},
		{ErrExpressionNotFound, pkg.ErrNotFound},
		{ErrExpressionNotCopyable, pkg.ErrForbidden},
		{ErrExpressionCloneSameServer, pkg.ErrBadRequest},
		{ErrExpressionLicenseLocked, pkg.ErrForbidden},
		{ErrExpressionSourceInvalid, pkg.ErrBadRequest},
	}
	for _, c := range cases {
		if !errors.Is(c.err, c.sentinel) {
			t.Errorf("%v does not wrap %v", c.err, c.sentinel)
		}
	}
}

// TestParseReactionEmoji_RejectsStickerToken pins D2-23: a sticker content
// token can never be stored as a reaction.
func TestParseReactionEmoji_RejectsStickerToken(t *testing.T) {
	for _, v := range []string{"<sticker:kedi:0123456789abcdef>", "<sticker:a:kedi:0123456789abcdef>"} {
		if _, _, _, err := ParseReactionEmoji(v); !errors.Is(err, ErrReactionEmojiInvalid) {
			t.Errorf("ParseReactionEmoji(%q) = %v, want ErrReactionEmojiInvalid", v, err)
		}
	}
}
