package testutil

import (
	"sync"
	"testing"
)

// AssertConcurrentWorkerStop checks the optional shutdown contract shared by
// cache owners, including repeated cleanup after concurrent shutdown callers.
func AssertConcurrentWorkerStop(t testing.TB, value any) {
	t.Helper()
	owner, ok := value.(interface{ Stop() })
	if !ok {
		t.Fatal("cache owner does not expose worker shutdown")
	}
	t.Cleanup(owner.Stop)
	var done sync.WaitGroup
	done.Add(8)
	for i := 0; i < 8; i++ {
		go func() { defer done.Done(); owner.Stop() }()
	}
	done.Wait()
}
