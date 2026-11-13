package testutil

import (
	"testing"
	"time"
)

// AssertWorkerCount observes runtime bookkeeping reaching its final count.
// A worker can signal completion from its final defer before its goroutine
// disappears from a profile. This does not rerun the fixture or relax the
// required final count; persistent workers still fail the assertion.
func AssertWorkerCount(t *testing.T, want int, count func() int) {
	t.Helper()
	deadline := time.NewTimer(500 * time.Millisecond)
	defer deadline.Stop()
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for {
		got := count()
		if got == want {
			return
		}
		select {
		case <-deadline.C:
			t.Fatalf("worker count did not settle: got=%d want=%d", got, want)
		case <-tick.C:
		}
	}
}
