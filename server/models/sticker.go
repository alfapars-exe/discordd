// Package models — sticker.go: per-server stickers (migration 087). Names
// share the emoji slug grammar and display_name rules (expression.go).
package models

import (
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/argeinfina/hichat/pkg"
)

const (
	// MaxStickersPerServer caps a server's stickers, static and animated
	// together, enforced atomically by the repository insert.
	MaxStickersPerServer = 30
	// StickerDescriptionMaxRunes caps description.
	StickerDescriptionMaxRunes = 100
	// StickerMaxTags caps the number of tags after de-duplication.
	StickerMaxTags = 5
	// StickerTagMaxRunes caps one tag.
	StickerTagMaxRunes = 20
)

// Sticker metadata errors (fixed literals, CWE-209).
var (
	ErrExpressionDescriptionInvalid = fmt.Errorf("%w: description must be at most 100 characters on one line without control or formatting characters", pkg.ErrBadRequest)
	ErrExpressionTagsInvalid        = fmt.Errorf("%w: at most 5 tags of 1-20 characters, without commas, control or formatting characters", pkg.ErrBadRequest)
)

// ServerSticker is one sticker of a server. URL / AnimatedURL are
// server-generated ("/api/uploads/stickers/{id}.png|.gif"), never client
// input. Tags and Description are never nil / absent in JSON.
type ServerSticker struct {
	ID          string   `json:"id"`
	ServerID    string   `json:"server_id"`
	Name        string   `json:"name"`
	DisplayName string   `json:"display_name"`
	Description string   `json:"description"`
	Tags        []string `json:"tags"`
	Animated    bool     `json:"animated"`
	URL         string   `json:"url"`
	AnimatedURL *string  `json:"animated_url"`
	Copyable    bool     `json:"copyable"`
	// ClonedFrom is the source sticker id when this row is a clone (the
	// source may since have been deleted); a clone is never copyable.
	ClonedFrom *string `json:"cloned_from"`
	CreatedBy  *string `json:"created_by"`
	CreatedAt  string  `json:"created_at"` // RFC3339 UTC
}

// CreateStickerRequest is the non-file part of a sticker upload.
type CreateStickerRequest struct {
	Name        string
	DisplayName string
	Description string
	Tags        []string
	Copyable    bool
	// ClonedFrom is server-set by the clone service only; never read from a
	// request. Non-empty forces the new row's Copyable to false.
	ClonedFrom string
}

// Validate normalises and checks the request in place, with the emoji rules
// for name and display_name (CreateEmojiRequest.Validate), plus description
// and tags. Tags is never nil afterwards.
func (r *CreateStickerRequest) Validate() error {
	dn, err := normalizeEmojiDisplayName(r.DisplayName)
	if err != nil {
		return err
	}
	r.DisplayName = dn

	name := strings.TrimSpace(r.Name)
	if name == "" {
		slug, ok := SlugifyExpressionName(dn)
		if !ok {
			return ErrExpressionNameInvalid
		}
		name = slug
	} else if !ValidExpressionSlug(name) {
		return ErrExpressionNameInvalid
	}
	r.Name = name

	desc, err := normalizeStickerDescription(r.Description)
	if err != nil {
		return err
	}
	r.Description = desc

	tags, err := NormalizeStickerTags(r.Tags)
	if err != nil {
		return err
	}
	r.Tags = tags
	return nil
}

// UpdateStickerRequest is the PATCH body; every field is optional but at
// least one must be present.
type UpdateStickerRequest struct {
	Name        *string   `json:"name"`
	DisplayName *string   `json:"display_name"`
	Description *string   `json:"description"`
	Tags        *[]string `json:"tags"`
	Copyable    *bool     `json:"copyable"`
}

// Validate normalises the present fields in place.
func (r *UpdateStickerRequest) Validate() error {
	if r.Name == nil && r.DisplayName == nil && r.Description == nil && r.Tags == nil && r.Copyable == nil {
		return ErrExpressionNoChanges
	}
	if r.Name != nil {
		name := strings.TrimSpace(*r.Name)
		if !ValidExpressionSlug(name) {
			return ErrExpressionNameInvalid
		}
		r.Name = &name
	}
	if r.DisplayName != nil {
		dn, err := normalizeEmojiDisplayName(*r.DisplayName)
		if err != nil {
			return err
		}
		r.DisplayName = &dn
	}
	if r.Description != nil {
		desc, err := normalizeStickerDescription(*r.Description)
		if err != nil {
			return err
		}
		r.Description = &desc
	}
	if r.Tags != nil {
		tags, err := NormalizeStickerTags(*r.Tags)
		if err != nil {
			return err
		}
		r.Tags = &tags
	}
	return nil
}

// normalizeStickerDescription trims s; 0-100 runes, and
// pkg.ContainsSteeringChars rejects (Cc included, so no newlines).
func normalizeStickerDescription(s string) (string, error) {
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) > StickerDescriptionMaxRunes || pkg.ContainsSteeringChars(s) {
		return "", ErrExpressionDescriptionInvalid
	}
	return s, nil
}

// NormalizeStickerTags trims every tag and skips empty ones; a tag holding a
// ',' or more than 20 runes or a steering character is rejected. Tags are
// de-duplicated case-insensitively (strings.ToLower key, first spelling
// kept); more than 5 remaining is rejected. The result is never nil.
// Mirrored by the client's normalizeStickerTags.
func NormalizeStickerTags(in []string) ([]string, error) {
	out := []string{}
	seen := make(map[string]struct{}, len(in))
	for _, raw := range in {
		tag := strings.TrimSpace(raw)
		if tag == "" {
			continue
		}
		if strings.Contains(tag, ",") || utf8.RuneCountInString(tag) > StickerTagMaxRunes || pkg.ContainsSteeringChars(tag) {
			return nil, ErrExpressionTagsInvalid
		}
		key := strings.ToLower(tag)
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, tag)
	}
	if len(out) > StickerMaxTags {
		return nil, ErrExpressionTagsInvalid
	}
	return out, nil
}
