package services

import (
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
			testutil.AssertConcurrentWorkerStop(t, fixture.create())
		})
	}
}
