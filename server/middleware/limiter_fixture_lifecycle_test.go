package middleware

import (
	"bytes"
	"github.com/argeinfina/hichat/testutil"
	"runtime/pprof"
	"testing"
)

func TestMiddlewareLimiterFixtureReleasesItsWorker(t *testing.T) {
	testutil.AssertLimiterFixtureCleanup(t, TestRateLimitByIP_BlocksAfterBudget, func() int {
		var stacks bytes.Buffer
		if err := pprof.Lookup("goroutine").WriteTo(&stacks, 2); err != nil {
			t.Fatal(err)
		}
		return bytes.Count(stacks.Bytes(), []byte("created by github.com/argeinfina/hichat/pkg/ratelimit.New"))
	})
}
