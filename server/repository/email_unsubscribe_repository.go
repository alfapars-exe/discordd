package repository

import (
	"context"
	"errors"
	"time"
)

var (
	ErrEmailUnsubscribeInvalid    = errors.New("invalid or expired email unsubscribe token")
	ErrEmailUnsubscribeIneligible = errors.New("email unsubscribe requires a verified address")
)

// EmailUnsubscribeTokenState contains only the category and whether a valid
// token has already been used. It deliberately carries no recipient identity.
type EmailUnsubscribeTokenState struct {
	Category string
	Consumed bool
}

// EmailUnsubscribeRepository issues random opaque proofs and applies a
// category-scoped opt-out only while the account still has the email
// generation that was verified when the proof was issued.
type EmailUnsubscribeRepository interface {
	Issue(context.Context, string, string, time.Time) (string, error)
	IssueForAddress(context.Context, string, string, string, time.Time) (string, error)
	Inspect(context.Context, string, time.Time) (EmailUnsubscribeTokenState, error)
	Consume(context.Context, string, time.Time) error
}
