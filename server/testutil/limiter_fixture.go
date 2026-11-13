package testutil

import "testing"

// AssertLimiterFixtureCleanup runs the actual fixture under a child test owner.
// Stack inspection belongs in the calling _test.go file; this helper only
// compares the supplied maintenance-worker counts after child cleanup.
func AssertLimiterFixtureCleanup(t *testing.T, fixture func(*testing.T), count func() int) {
	t.Helper()
	before := count()
	t.Run("owner", fixture)
	AssertWorkerCount(t, before, count)
}
