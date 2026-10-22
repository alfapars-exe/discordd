// Package models — expression.go: per-server custom emojis (migration 086)
// and the reaction-emoji grammar shared by channel and DM reactions.
package models

import (
	"fmt"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/argeinfina/hichat/pkg"
)

const (
	// MaxStaticEmojisPerServer / MaxAnimatedEmojisPerServer are separate
	// per-type caps, enforced atomically by the repository insert.
	MaxStaticEmojisPerServer   = 100
	MaxAnimatedEmojisPerServer = 50
	// ExpressionMaxUploadBytes caps the uploaded source file.
	ExpressionMaxUploadBytes = 512 << 10
	// EmojiDisplayNameMaxRunes caps display_name.
	EmojiDisplayNameMaxRunes = 32
	// ReactionEmojiMaxRunes caps a Unicode reaction emoji. Most emojis are
	// 1-2 code points; ZWJ families and flags can exceed 10.
	ReactionEmojiMaxRunes = 32
	// expressionSlugMaxLen is the shortcode length cap (ASCII, so bytes).
	expressionSlugMaxLen = 32
)

// Expression errors. Messages are fixed literals (CWE-209); each wraps the
// pkg sentinel that decides its HTTP status, and the handler attaches the
// matching EXPRESSION_* code.
var (
	ErrExpressionNameInvalid        = fmt.Errorf("%w: emoji name must be 2-32 characters of a-z, 0-9 and _", pkg.ErrBadRequest)
	ErrExpressionDisplayNameInvalid = fmt.Errorf("%w: display name must be 1-32 characters without control or formatting characters", pkg.ErrBadRequest)
	ErrExpressionNameTaken          = fmt.Errorf("%w: an emoji with this name already exists in this server", pkg.ErrAlreadyExists)
	ErrExpressionLimitReached       = fmt.Errorf("%w: this server has reached its emoji limit", pkg.ErrBadRequest)
	ErrExpressionLicenseCreatorOnly = fmt.Errorf("%w: only the emoji's creator can change whether it is copyable", pkg.ErrForbidden)
	ErrExpressionNoChanges          = fmt.Errorf("%w: at least one field is required", pkg.ErrBadRequest)
)

// Reaction-emoji errors. "emoji is required" / "emoji too long" keep the
// exact text the channel reaction path returned before custom emojis.
var (
	ErrReactionEmojiRequired = fmt.Errorf("%w: emoji is required", pkg.ErrBadRequest)
	ErrReactionEmojiTooLong  = fmt.Errorf("%w: emoji too long", pkg.ErrBadRequest)
	ErrReactionEmojiInvalid  = fmt.Errorf("%w: invalid emoji", pkg.ErrBadRequest)
	// ErrUnknownEmoji covers a missing custom emoji, an animated-flag
	// mismatch and a caller who is not a member of the emoji's server —
	// deliberately one error so an emoji id cannot be probed.
	ErrUnknownEmoji = fmt.Errorf("%w: unknown emoji", pkg.ErrBadRequest)
)

// ServerEmoji is one custom emoji of a server. URL / AnimatedURL are
// server-generated ("/api/uploads/emojis/{id}.png|.gif"), never client input.
type ServerEmoji struct {
	ID          string  `json:"id"`
	ServerID    string  `json:"server_id"`
	Name        string  `json:"name"`
	DisplayName string  `json:"display_name"`
	Animated    bool    `json:"animated"`
	URL         string  `json:"url"`
	AnimatedURL *string `json:"animated_url"`
	Copyable    bool    `json:"copyable"`
	CreatedBy   *string `json:"created_by"`
	// ClonedFrom is the source emoji id when this row is a clone (the
	// source may since have been deleted); a clone is never copyable.
	ClonedFrom *string `json:"cloned_from"`
	CreatedAt  string  `json:"created_at"` // RFC3339 UTC
}

// CreateEmojiRequest is the non-file part of an emoji upload.
type CreateEmojiRequest struct {
	Name        string
	DisplayName string
	Copyable    bool
	// ClonedFrom is server-set by the clone service only; never read from a
	// request. Non-empty forces the new row's Copyable to false.
	ClonedFrom string
}

// Validate normalises and checks the request in place: display_name is
// trimmed and checked; an empty name is derived from display_name with
// SlugifyExpressionName, a given name is trimmed and must already be a
// valid slug.
func (r *CreateEmojiRequest) Validate() error {
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
	return nil
}

// UpdateEmojiRequest is the PATCH body; every field is optional but at
// least one must be present.
type UpdateEmojiRequest struct {
	Name        *string `json:"name"`
	DisplayName *string `json:"display_name"`
	Copyable    *bool   `json:"copyable"`
}

// Validate normalises the present fields in place.
func (r *UpdateEmojiRequest) Validate() error {
	if r.Name == nil && r.DisplayName == nil && r.Copyable == nil {
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
	return nil
}

func normalizeEmojiDisplayName(s string) (string, error) {
	s = strings.TrimSpace(s)
	if n := utf8.RuneCountInString(s); n < 1 || n > EmojiDisplayNameMaxRunes {
		return "", ErrExpressionDisplayNameInvalid
	}
	if pkg.ContainsSteeringChars(s) {
		return "", ErrExpressionDisplayNameInvalid
	}
	return s, nil
}

var expressionSlugRegex = regexp.MustCompile(`^[a-z0-9_]{2,32}$`)

// ValidExpressionSlug reports whether s is a valid emoji shortcode.
func ValidExpressionSlug(s string) bool {
	return expressionSlugRegex.MatchString(s)
}

// turkishFold maps the Turkish (and circumflexed) letters to their ASCII
// base letter. Mirrored verbatim by the client's slugifyExpressionName.
var turkishFold = map[rune]rune{
	'ç': 'c', 'ğ': 'g', 'ı': 'i', 'İ': 'i', 'ö': 'o', 'ş': 's', 'ü': 'u',
	'Ç': 'c', 'Ğ': 'g', 'Ö': 'o', 'Ş': 's', 'Ü': 'u',
	'â': 'a', 'î': 'i', 'û': 'u',
}

// SlugifyExpressionName derives a shortcode from a display name: Turkish
// letters fold to ASCII, ASCII is lower-cased, space / tab / CR / LF / '-' /
// '.' become '_' (exactly these — the client mirrors the set), everything outside [a-z0-9_] is dropped, runs of '_' collapse,
// leading/trailing '_' are trimmed, and the result is cut to 32 characters
// (then trailing '_' trimmed again). ok is false when fewer than 2
// characters remain.
func SlugifyExpressionName(s string) (string, bool) {
	var b strings.Builder
	lastUnderscore := false
	for _, r := range s {
		if f, ok := turkishFold[r]; ok {
			r = f
		}
		if r >= 'A' && r <= 'Z' {
			r += 'a' - 'A'
		}
		switch r {
		case ' ', '\t', '\r', '\n', '-', '.':
			r = '_'
		}
		switch {
		case r == '_':
			if lastUnderscore {
				continue
			}
			lastUnderscore = true
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			lastUnderscore = false
		default:
			continue
		}
		b.WriteRune(r)
	}
	out := strings.Trim(b.String(), "_")
	if len(out) > expressionSlugMaxLen {
		out = strings.TrimRight(out[:expressionSlugMaxLen], "_")
	}
	if len(out) < 2 {
		return "", false
	}
	return out, true
}

// reactionCustomRegex is the stored reaction key for a custom emoji: id
// only, no name, so renaming an emoji never splits its reaction group.
var reactionCustomRegex = regexp.MustCompile(`^<(a?):([a-f0-9]{16})>$`)

// ParseReactionEmoji classifies a reaction value (surrounding whitespace is
// ignored). "<:ID>" / "<a:ID>" is a custom emoji (custom=true, id, animated).
// Anything else is a Unicode emoji: 1-32 runes, no control or bidi
// formatting characters (isBidiControl), and
// it may not start with '<' — the content-token form "<:name:id>" and any
// other markup-looking value are rejected. ZWJ (U+200D) is deliberately
// allowed: it is a format character, not a control, and family emojis need
// it — so pkg.ContainsSteeringChars must NOT be used here.
func ParseReactionEmoji(s string) (custom bool, id string, animated bool, err error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return false, "", false, ErrReactionEmojiRequired
	}
	if m := reactionCustomRegex.FindStringSubmatch(s); m != nil {
		return true, m[2], m[1] == "a", nil
	}
	if strings.HasPrefix(s, "<") {
		return false, "", false, ErrReactionEmojiInvalid
	}
	if utf8.RuneCountInString(s) > ReactionEmojiMaxRunes {
		return false, "", false, ErrReactionEmojiTooLong
	}
	if !utf8.ValidString(s) {
		return false, "", false, ErrReactionEmojiInvalid
	}
	for _, r := range s {
		if unicode.IsControl(r) || isBidiControl(r) {
			return false, "", false, ErrReactionEmojiInvalid
		}
	}
	return false, "", false, nil
}

// isBidiControl reports the bidirectional formatting characters a reaction
// may not carry: LRM/RLM (U+200E/F), ALM (U+061C), the embeddings and
// overrides U+202A–U+202E and the isolates U+2066–U+2069. Other format
// characters emoji sequences need — ZWJ U+200D, VS16 U+FE0F, tag
// characters — stay allowed.
func isBidiControl(r rune) bool {
	switch {
	case r == 0x200E, r == 0x200F, r == 0x061C:
		return true
	case r >= 0x202A && r <= 0x202E:
		return true
	case r >= 0x2066 && r <= 0x2069:
		return true
	}
	return false
}

// ReactionKeyForCustomEmoji is the stored reaction key for a custom emoji.
func ReactionKeyForCustomEmoji(id string, animated bool) string {
	if animated {
		return "<a:" + id + ">"
	}
	return "<:" + id + ">"
}
