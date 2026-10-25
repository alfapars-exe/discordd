package services

import (
	"context"
	"errors"
)

type expectedAuthAccountKey struct{}
type expectedAuthSessionKey struct{}

var ErrAuthAccountMismatch = errors.New("authentication account changed")
var ErrAuthSessionMismatch = errors.New("authentication session changed")

func WithExpectedAuthSession(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, expectedAuthSessionKey{}, id)
}
func checkExpectedAuthSession(ctx context.Context, id string) error {
	expected, _ := ctx.Value(expectedAuthSessionKey{}).(string)
	if expected != "" && expected != id {
		return ErrAuthSessionMismatch
	}
	return nil
}

// WithExpectedAuthAccount adds a constraint, never an authentication identity.
// The cookie/session still authenticates the request. This prevents a stale tab
// from rotating or revoking another account's shared refresh cookie.
func WithExpectedAuthAccount(ctx context.Context, userID string) context.Context {
	return context.WithValue(ctx, expectedAuthAccountKey{}, userID)
}

func checkExpectedAuthAccount(ctx context.Context, actual string) error {
	expected, _ := ctx.Value(expectedAuthAccountKey{}).(string)
	if expected != "" && expected != actual {
		return ErrAuthAccountMismatch
	}
	return nil
}
