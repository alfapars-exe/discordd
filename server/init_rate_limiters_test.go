package main

import (
	"github.com/argeinfina/hichat/pkg/ratelimit"
	"strconv"
	"testing"
	"time"
)

func TestLimiterAssemblyRollsBackEveryPartialConstruction(t *testing.T) {
	for failure := 1; failure <= 18; failure++ {
		t.Run(strconv.Itoa(failure), func(t *testing.T) {
			before := limiterWorkerCount(t)
			marker := new(int)
			calls := 0
			beforeCreate := func() {
				calls++
				if calls == failure {
					panic(marker)
				}
			}
			login := func(max int, window time.Duration) *ratelimit.LoginRateLimiter {
				beforeCreate()
				limiter := ratelimit.NewLoginRateLimiter(max, window)
				t.Cleanup(limiter.Stop)
				return limiter
			}
			message := func(max int, window, cooldown time.Duration) *ratelimit.MessageRateLimiter {
				beforeCreate()
				limiter := ratelimit.NewMessageRateLimiter(max, window, cooldown)
				t.Cleanup(limiter.Stop)
				return limiter
			}
			var caught any
			func() { defer func() { caught = recover() }(); initRateLimiters(login, message) }()
			if caught != marker || calls != failure {
				t.Fatalf("constructor failure changed: panic=%v calls=%d", caught, calls)
			}
			if after := limiterWorkerCount(t); after != before {
				t.Fatalf("partial construction retained workers: before=%d after=%d", before, after)
			}
		})
	}
}

func TestLimiterAssemblyTransfersAllWorkersOnSuccess(t *testing.T) {
	before := limiterWorkerCount(t)
	bundle := initRateLimiters(ratelimit.NewLoginRateLimiter, ratelimit.NewMessageRateLimiter)
	t.Cleanup(bundle.Stop)
	if after := limiterWorkerCount(t); after != before+18 {
		t.Fatalf("successful assembly transferred %d workers, want 18", after-before)
	}
	bundle.Stop()
	if after := limiterWorkerCount(t); after != before {
		t.Fatalf("caller retained %d workers", after-before)
	}
}
