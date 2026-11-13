package cache

import (
	"sync"
	"testing"
	"time"
)

func TestCloseSupportsConcurrentResourceOwners(t *testing.T) {
	cache := New[string, int](time.Hour, time.Hour)
	const owners = 16
	start := make(chan struct{})
	failures := make(chan any, owners)
	var done sync.WaitGroup
	done.Add(owners)
	for i := 0; i < owners; i++ {
		go func() {
			defer done.Done()
			defer func() {
				if value := recover(); value != nil {
					failures <- value
				}
			}()
			<-start
			cache.Close()
		}()
	}
	close(start)
	done.Wait()
	close(failures)
	for failure := range failures {
		t.Errorf("repeated resource close panicked: %v", failure)
	}
}

func TestCloseCompletesWorkerAndPreservesDrainingCacheAccess(t *testing.T) {
	cache := New[string, int](time.Hour, time.Hour)
	cache.Set("key", 7)
	cache.Close()
	select {
	case <-cache.cleanupDone:
	default:
		t.Fatal("Close returned before worker completion")
	}
	if value, ok := cache.Get("key"); !ok || value != 7 {
		t.Fatal("Close discarded data needed by draining requests")
	}
	cache.Set("later", 8)
	if value, ok := cache.Get("later"); !ok || value != 8 {
		t.Fatal("draining cache operations stopped working")
	}
	cache.Close()
}
