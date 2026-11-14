package middleware

import (
	"testing"

	"github.com/argeinfina/hichat/testutil"
)

func TestCacheBackedMiddlewareExposeIdempotentWorkerStop(t *testing.T) {
	for _, fixture := range []struct {
		name   string
		create func() any
	}{
		{"auth", func() any { return NewAuthMiddleware(nil, nil, nil, nil) }},
		{"permission", func() any { return NewPermissionMiddleware(nil, nil) }},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			testutil.AssertConcurrentWorkerStop(t, fixture.create())
		})
	}
}
