package services

import (
	"sync"
	"testing"

	"github.com/argeinfina/hichat/testutil"
)

func TestCacheBackedServicesExposeIdempotentWorkerStop(t *testing.T) {
	for _, fixture := range []struct {
		name   string
		create func() any
	}{
		{"permissions", func() any {
			return NewChannelPermissionService(&testutil.MockChannelPermRepo{}, &testutil.MockRoleRepo{}, &testutil.MockChannelRepo{}, nil)
		}},
		{"websocket_tickets", func() any { return NewWSTicketService() }},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			owner, ok := fixture.create().(interface{ Stop() })
			if !ok {
				t.Fatal("cache-backed service does not expose worker shutdown")
			}
			t.Cleanup(owner.Stop)
			var done sync.WaitGroup
			done.Add(8)
			for i := 0; i < 8; i++ {
				go func() { defer done.Done(); owner.Stop() }()
			}
			done.Wait()
		})
	}
}
