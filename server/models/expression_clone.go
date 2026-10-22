// Package models — expression_clone.go: copying a copyable emoji or sticker
// into another server.
package models

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/argeinfina/hichat/pkg"
)

// ExpressionStoredFileMaxBytes caps a stored expression file the clone path
// reads back from disk. Stored files are our own encoder output (emoji
// animated ≤512 KiB, sticker animated ≤1 MiB), so anything larger is not one.
const ExpressionStoredFileMaxBytes = 1 << 20

// Clone errors (fixed literals, CWE-209).
var (
	// ErrExpressionNotFound covers a missing source, a source in a server
	// the caller is not a member of and a source whose file is gone —
	// deliberately one error so an expression id cannot be probed.
	ErrExpressionNotFound        = fmt.Errorf("%w: expression not found", pkg.ErrNotFound)
	ErrExpressionNotCopyable     = fmt.Errorf("%w: this expression is not copyable", pkg.ErrForbidden)
	ErrExpressionCloneSameServer = fmt.Errorf("%w: the expression already belongs to this server", pkg.ErrBadRequest)
	// ErrExpressionLicenseLocked: a clone's copyable flag can never change,
	// so a cloner cannot re-license someone else's work.
	ErrExpressionLicenseLocked = fmt.Errorf("%w: this expression is a copy; its licence cannot be changed", pkg.ErrForbidden)
	ErrExpressionSourceInvalid = fmt.Errorf("%w: invalid source_id", pkg.ErrBadRequest)
)

var expressionIDRegex = regexp.MustCompile(`^[a-f0-9]{16}$`)

// CloneExpressionRequest is the body of POST .../{emojis|stickers}/clone.
// Name optionally renames the copy (e.g. when the source's name is taken
// in the target server).
type CloneExpressionRequest struct {
	SourceID string  `json:"source_id"`
	Name     *string `json:"name"`
}

// Validate checks SourceID's shape and normalises Name in place (trimmed,
// must be a valid slug; an empty or absent name means "keep the source's").
func (r *CloneExpressionRequest) Validate() error {
	if !expressionIDRegex.MatchString(r.SourceID) {
		return ErrExpressionSourceInvalid
	}
	if r.Name != nil {
		name := strings.TrimSpace(*r.Name)
		if name == "" {
			r.Name = nil
			return nil
		}
		if !ValidExpressionSlug(name) {
			return ErrExpressionNameInvalid
		}
		r.Name = &name
	}
	return nil
}
