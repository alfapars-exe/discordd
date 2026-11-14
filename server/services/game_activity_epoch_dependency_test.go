package services

import (
	"github.com/argeinfina/hichat/testutil"
	"github.com/google/uuid"
	"testing"
)

type activityEpochProvider struct {
	testutil.MockBroadcaster
	calls int
}

func (h *activityEpochProvider) GameActivityEpoch() string { h.calls++; return "undeclared-epoch" }
func TestGameActivityEpochIsExplicitAndStandaloneEpochsAreIndependent(t *testing.T) {
	hub := &activityEpochProvider{}
	selected := NewGameActivityService(nil, nil, nil, hub, "selected-epoch")
	first := NewGameActivityService(nil, nil, nil, hub, "")
	second := NewGameActivityService(nil, nil, nil, hub, "")
	if selected.epoch != "selected-epoch" || hub.calls != 0 {
		t.Fatal("constructor rediscovered epoch provider")
	}
	if _, err := uuid.Parse(first.epoch); err != nil {
		t.Fatal("standalone epoch is not a UUID")
	}
	if first.epoch == second.epoch || first.epoch == selected.epoch {
		t.Fatal("standalone epoch identity reused")
	}
}
