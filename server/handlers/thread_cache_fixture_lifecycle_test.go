package handlers

import (
	"bytes"
	"github.com/argeinfina/hichat/testutil"
	"runtime/pprof"
	"testing"
)

func TestThreadHTTPFixtureReleasesPermissionCache(t *testing.T) {
	count := func() int {
		var stacks bytes.Buffer
		if err := pprof.Lookup("goroutine").WriteTo(&stacks, 2); err != nil {
			t.Fatal(err)
		}
		return bytes.Count(stacks.Bytes(), []byte("created by github.com/argeinfina/hichat/pkg/cache.New["))
	}
	before := count()
	t.Run("owner", TestThreadSQLiteHTTPArchiveAccessAndReopen)
	testutil.AssertWorkerCount(t, before, count)
}
