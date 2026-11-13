package testutil

import (
	"bytes"
	"runtime/pprof"
	"testing"
)

// AssertLimiterFixtureCleanup runs the actual fixture under a child test owner
// and checks that its cleanup restores the maintenance-worker count.
func AssertLimiterFixtureCleanup(t *testing.T, fixture func(*testing.T)) {
	t.Helper()
	count := func() int {
		var stacks bytes.Buffer
		if err := pprof.Lookup("goroutine").WriteTo(&stacks, 2); err != nil {
			t.Fatal(err)
		}
		return bytes.Count(stacks.Bytes(), []byte("created by github.com/argeinfina/hichat/pkg/ratelimit.New"))
	}
	before := count()
	t.Run("owner", fixture)
	if after := count(); after != before {
		t.Fatalf("fixture retained limiter workers: before=%d after=%d", before, after)
	}
}
