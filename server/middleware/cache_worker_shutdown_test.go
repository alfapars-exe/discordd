package middleware

import (
	"sync"
	"testing"
)

func TestCacheBackedMiddlewareExposeIdempotentWorkerStop(t *testing.T) {
	for _, fixture := range []struct {
		name   string
		create func() any
	}{
		{"auth", func() any { return NewAuthMiddleware(nil, nil, nil) }},
		{"permission", func() any { return NewPermissionMiddleware(nil) }},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			owner, ok := fixture.create().(interface{ Stop() })
			if !ok {
				t.Fatal("cache-backed middleware does not expose worker shutdown")
			}
			t.Cleanup(owner.Stop)
			var done sync.WaitGroup
			done.Add(8)
			for i := 0; i < 8; i++ {
				go func() { defer done.Done(); owner.Stop() }()
			}
			done.Wait()
		})
	}
}
