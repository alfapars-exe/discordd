// Package pkg — request-ID context helpers.
//
// The RequestLogger middleware stamps a request_id on each inbound HTTP
// request and stores it here so error paths, service-layer logs, and
// business-logic breadcrumbs can correlate to the access log line. Kept
// in pkg (not middleware) so any package can import it — pkg has no
// upstream dependencies inside this module, which sidesteps the classic
// import-cycle you get when a "core" concept lives in a leaf package.

package pkg

import "context"

// requestIDCtxKey is unexported so no external caller can accidentally
// collide on the string "request_id". The typed key is the idiomatic
// Go context pattern for avoiding cross-package key collisions.
type requestIDCtxKey struct{}

// WithRequestID returns a derived context carrying id.
func WithRequestID(ctx context.Context, id string) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithValue(ctx, requestIDCtxKey{}, id)
}

// RequestIDFrom returns the request_id previously stored via WithRequestID.
// Returns "" if none was set — callers should tolerate that (unauthenticated
// health probes, tests, background jobs).
func RequestIDFrom(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	if id, ok := ctx.Value(requestIDCtxKey{}).(string); ok {
		return id
	}
	return ""
}
