package main

import (
	"runtime"
	"testing"

	"github.com/argeinfina/hichat/config"
	"github.com/argeinfina/hichat/ws"
)

type failingStartupHub struct {
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
