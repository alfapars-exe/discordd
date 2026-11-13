package services

import (
	"runtime"
	"strings"
	"testing"
	"time"
)

func permissionFixtureCacheWorkers() int {
	buffer := make([]byte, 1<<20)
	for {
		size := runtime.Stack(buffer, true)
		if size < len(buffer) {
			count := 0
			for _, stack := range strings.Split(string(buffer[:size]), "\n\n") {
				if strings.Contains(stack, "/pkg/cache.New[") && strings.Contains(stack, ".func1(") {
					count++
				}
			}
			return count
		}
		buffer = make([]byte, len(buffer)*2)
	}
}

func TestPermissionFixtureReleasesCacheWorkersWithItsTestOwner(t *testing.T) {
	before := permissionFixtureCacheWorkers()
	t.Run("owner", TestResolveChannelPermissionsBulk_ParityWithSinglePath)
	deadline := time.Now().Add(500 * time.Millisecond)
	for {
		after := permissionFixtureCacheWorkers()
		if after <= before {
			t.Logf("cache cleanup workers before=%d after=%d", before, after)
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("test owner retained cache workers: before=%d after=%d", before, after)
		}
		time.Sleep(time.Millisecond)
	}
}
