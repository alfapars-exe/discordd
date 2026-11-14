package main

import (
	"runtime"
	"testing"

	"github.com/argeinfina/hichat/config"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
)

type failingStartupHub struct {
	services.AuthSessionDisconnecter
	services.GameJoinConnectionGate
	ws.EventPublisher
	marker any
}

func (h *failingStartupHub) OnGameJoinOffer(func(string, uint64, any) any) { panic(h.marker) }

func TestServiceInitializationReleasesCacheWhenHubWiringPanics(t *testing.T) {
	before := routeCacheWorkerCount(t)
	marker := new(int)
	var caught any
	func() {
		defer func() { caught = recover() }()
		initServices(nil, &Repositories{}, &failingStartupHub{marker: marker}, &config.Config{}, nil, nil)
	}()
	if caught != marker {
		t.Fatalf("did not reach intended hub failure: %v", caught)
	}
	if after := routeCacheWorkerCount(t); after != before {
		t.Fatalf("service initialization retained cache workers: before=%d after=%d", before, after)
	}
}

func TestServiceInitializationReleasesCacheOnEarlyConfigFailure(t *testing.T) {
	before := routeCacheWorkerCount(t)
	var caught any
	func() {
		defer func() { caught = recover() }()
		initServices(nil, &Repositories{}, nil, nil, nil, nil)
	}()
	if _, ok := caught.(runtime.Error); !ok {
		t.Fatalf("did not reach configuration dereference failure: %v", caught)
	}
	if after := routeCacheWorkerCount(t); after != before {
		t.Fatalf("early initialization retained cache workers: before=%d after=%d", before, after)
	}
}

func (h *failingStartupHub) IsVisibleOnline(string) (bool, error) { return false, nil }
func (h *failingStartupHub) SetDurableChannelSends(bool)          {}

func TestServiceInitializationTransfersLiveWorkersToSuccessfulCaller(t *testing.T) {
	caches, limitersBefore := routeCacheWorkerCount(t), limiterWorkerCount(t)
	svcs, limiters, metrics := initServices(nil, &Repositories{}, ws.NewHub(), &config.Config{}, nil, nil)
	t.Cleanup(func() {
		limiters.Stop()
		stopServiceCacheWorkers(svcs)
		metrics.Stop()
		if owner, ok := svcs.Voice.(interface{ ShutdownVoiceStateFanout() }); ok {
			owner.ShutdownVoiceStateFanout()
		}
		if owner, ok := svcs.OnlineFriendNotifier.(interface{ Stop() }); ok {
			owner.Stop()
		}
		if owner, ok := svcs.LinkPreview.(interface{ Stop() }); ok {
			owner.Stop()
		}
	})
	if got := routeCacheWorkerCount(t); got != caches+4 {
		t.Fatalf("successful initialization transferred %d cache workers, want 4", got-caches)
	}
	if got := limiterWorkerCount(t); got != limitersBefore+18 {
		t.Fatalf("successful initialization transferred %d limiter workers, want 18", got-limitersBefore)
	}
	stopServiceCacheWorkers(svcs)
	limiters.Stop()
	if got := routeCacheWorkerCount(t); got != caches {
		t.Fatalf("caller retained %d cache workers", got-caches)
	}
	if got := limiterWorkerCount(t); got != limitersBefore {
		t.Fatalf("caller retained %d limiter workers", got-limitersBefore)
	}
}
