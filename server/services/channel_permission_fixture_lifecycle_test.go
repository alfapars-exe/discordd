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
	for _, fixture := range []struct {
		name string
		run  func(*testing.T)
	}{
		{"parity", TestResolveChannelPermissionsBulk_ParityWithSinglePath},
		{"fresh_music_access", TestMusicAccessFreshPermissionBypassesPositiveCacheAndHonorsInvalidation},
		{"message_recipients", TestBroadcastCreate_RecipientsMatchBulkResolver},
		{"search", TestSearch_ExcludesUnreadableChannel},
		{"stream_notifier", TestVerifyCurrentScreenShareUsesLiveKitParticipantAndExactTrack},
		{"thread_invalidation", TestParentOverrideInvalidatesWarmThreadReaders},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			before := permissionFixtureCacheWorkers()
			t.Run("owner", fixture.run)
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
		})
	}
}
