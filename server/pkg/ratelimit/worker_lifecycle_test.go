package ratelimit

import (
	"sync"
	"testing"
	"time"
)

func TestLimiterShutdownPreservesBudgetsAndSupportsConcurrentOwners(t *testing.T) {
	for _, fixture := range []struct {
		name   string
		create func() interface{ Allow(string) bool }
	}{
		{"login", func() interface{ Allow(string) bool } { return NewLoginRateLimiter(1, time.Hour) }},
		{"message", func() interface{ Allow(string) bool } { return NewMessageRateLimiter(1, time.Hour, 0) }},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			limiter := fixture.create()
			owner, ok := limiter.(interface{ Stop() })
			if !ok {
				t.Fatal("limiter cleanup worker has no shutdown owner")
			}
			t.Cleanup(owner.Stop)
			if !limiter.Allow("existing") || limiter.Allow("existing") {
				t.Fatal("fixture did not exhaust budget")
			}
			var callers sync.WaitGroup
			callers.Add(16)
			for i := 0; i < 16; i++ {
				go func() { defer callers.Done(); owner.Stop() }()
			}
			callers.Wait()
			var done <-chan struct{}
			switch value := limiter.(type) {
			case *LoginRateLimiter:
				done = value.cleanupDone
			case *MessageRateLimiter:
				done = value.cleanupDone
			}
			select {
			case <-done:
			default:
				t.Fatal("Stop returned before cleanup completed")
			}

			if limiter.Allow("existing") {
				t.Fatal("shutdown reset an exhausted budget")
			}
			if !limiter.Allow("draining") || limiter.Allow("draining") {
				t.Fatal("draining request budget changed")
			}
		})
	}
}
