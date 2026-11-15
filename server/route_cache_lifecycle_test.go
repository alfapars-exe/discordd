package main

import (
	"bytes"
	"net/http"
	"runtime/pprof"
	"strconv"
	"testing"

	"github.com/argeinfina/hichat/testutil"
)

type failingRouteRegistrar struct {
	remaining int
	marker    any
}

func (r *failingRouteRegistrar) register() {
	r.remaining--
	if r.remaining == 0 {
		panic(r.marker)
	}
}
func (r *failingRouteRegistrar) Handle(_ string, _ http.Handler) { r.register() }
func (r *failingRouteRegistrar) HandleFunc(_ string, _ func(http.ResponseWriter, *http.Request)) {
	r.register()
}

func routeCacheWorkerCount(t *testing.T) int {
	t.Helper()
	var stacks bytes.Buffer
	if err := pprof.Lookup("goroutine").WriteTo(&stacks, 2); err != nil {
		t.Fatal(err)
	}
	return bytes.Count(stacks.Bytes(), []byte("created by github.com/argeinfina/hichat/pkg/cache.New["))
}

func TestRouteInitializationOwnsCacheWorkersUntilSuccessfulReturn(t *testing.T) {
	for _, position := range []int{1, 100} {
		t.Run(strconv.Itoa(position), func(t *testing.T) {
			before := routeCacheWorkerCount(t)
			marker := new(int)
			var caught any
			func() {
				defer func() { caught = recover() }()
				initRoutes(&failingRouteRegistrar{remaining: position, marker: marker}, &Handlers{}, nil, nil, nil, nil, nil, nil, nil, nil, nil)
			}()
			if caught != marker {
				t.Fatalf("registration panic changed: %v", caught)
			}
			testutil.AssertWorkerCount(t, before, func() int { return routeCacheWorkerCount(t) })
		})
	}
	t.Run("successful_handoff", func(t *testing.T) {
		before := routeCacheWorkerCount(t)
		auth, perm := initRoutes(&recordingRegistrar{}, &Handlers{}, nil, nil, nil, nil, nil, nil, nil, nil, nil)
		t.Cleanup(auth.Stop)
		t.Cleanup(perm.Stop)
		if after := routeCacheWorkerCount(t); after != before+2 {
			t.Fatalf("successful registration did not transfer two live workers: before=%d after=%d", before, after)
		}
		auth.Stop()
		perm.Stop()
		testutil.AssertWorkerCount(t, before, func() int { return routeCacheWorkerCount(t) })
	})
}

func TestRouteInspectionFixturesReleaseCacheWorkers(t *testing.T) {
	before := routeCacheWorkerCount(t)
	for i := 0; i < 20; i++ {
		captureRoutes()
	}
	t.Run("permission_fixture", TestRoutePermissions_EveryRouteHasADeclaredGate)
	testutil.AssertWorkerCount(t, before, func() int { return routeCacheWorkerCount(t) })
}
