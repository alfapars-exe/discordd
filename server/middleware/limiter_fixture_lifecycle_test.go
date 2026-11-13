package middleware

import (
	"github.com/argeinfina/hichat/testutil"
	"testing"
)

func TestMiddlewareLimiterFixtureReleasesItsWorker(t *testing.T) {
	testutil.AssertLimiterFixtureCleanup(t, TestRateLimitByIP_BlocksAfterBudget)
}
