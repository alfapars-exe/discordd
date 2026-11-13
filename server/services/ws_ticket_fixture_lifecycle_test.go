package services

import (
	"bytes"
	"github.com/argeinfina/hichat/testutil"
	"runtime/pprof"
	"testing"
)

func TestWSTicketFixturesReleaseCacheWorkers(t *testing.T) {
	count := func() int {
		var stacks bytes.Buffer
		if err := pprof.Lookup("goroutine").WriteTo(&stacks, 2); err != nil {
			t.Fatal(err)
		}
		return bytes.Count(stacks.Bytes(), []byte("created by github.com/argeinfina/hichat/pkg/cache.New["))
	}
	for _, fixture := range []struct {
		name string
		run  func(*testing.T)
	}{
		{"TestWSTicket_IssueThenConsumeOnce", TestWSTicket_IssueThenConsumeOnce},
		{"TestWSTicket_ConsumeInvalid", TestWSTicket_ConsumeInvalid},
		{"TestWSTicket_IssueProducesDistinctTickets", TestWSTicket_IssueProducesDistinctTickets},
		{"TestWSTicket_ConsumeReturnsTheBoundUser", TestWSTicket_ConsumeReturnsTheBoundUser},
		{"TestWSTicket_ConsumeReturnsTheStampedTokenVersion", TestWSTicket_ConsumeReturnsTheStampedTokenVersion},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			before := count()
			t.Run("owner", fixture.run)
			testutil.AssertWorkerCount(t, before, count)
		})
	}
}
