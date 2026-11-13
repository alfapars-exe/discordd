package services

import (
	"context"
	"github.com/argeinfina/hichat/models"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestVoiceMaintenanceHasOwnedShutdown(t *testing.T) {
	if _, ok := any(&voiceService{}).(interface{ StopMaintenance() }); !ok {
		t.Fatal("voice cleanup workers have no owner shutdown")
	}
}

func TestVoiceMaintenanceStopJoinsSweepAndConcurrentOwners(t *testing.T) {
	var worker voiceMaintenanceWorker
	entered := make(chan struct{})
	release := make(chan struct{})
	var calls atomic.Int32
	sweep := func() {
		if calls.Add(1) == 1 {
			close(entered)
		}
		<-release
	}
	var starts sync.WaitGroup
	for i := 0; i < 16; i++ {
		starts.Add(1)
		go func() { defer starts.Done(); worker.start(time.Millisecond, sweep) }()
	}
	starts.Wait()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("sweep not started")
	}
	done := make(chan struct{})
	go func() {
		var stops sync.WaitGroup
		for i := 0; i < 16; i++ {
			stops.Add(1)
			go func() { defer stops.Done(); worker.stop() }()
		}
		stops.Wait()
		close(done)
	}()
	deadline := time.Now().Add(time.Second)
	for {
		worker.mu.Lock()
		stopped := worker.stopped
		worker.mu.Unlock()
		if stopped {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("Stop never cancelled worker")
		}
		time.Sleep(time.Millisecond)
	}
	select {
	case <-done:
		t.Fatal("Stop returned before sweep exited")
	default:
	}
	close(release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Stop did not join sweep")
	}
	if calls.Load() != 1 {
		t.Fatalf("duplicate sweeps: %d", calls.Load())
	}
	worker.start(time.Millisecond, func() { t.Error("terminal worker restarted") })
	worker.stop()
}

func TestVoiceMaintenanceStopBeforeStart(t *testing.T) {
	var worker voiceMaintenanceWorker
	worker.stop()
	worker.start(time.Millisecond, func() { t.Error("stopped worker started") })
	if worker.done != nil {
		t.Fatal("Stop-before-Start created a worker")
	}
	worker.stop()
}

func TestVoiceMaintenancePublicOwnersJoin(t *testing.T) {
	s := &voiceService{}
	s.StartOrphanCleanup()
	s.StartAFKChecker()
	firstOrphan, firstAFK := s.orphanWorker.done, s.afkWorker.done
	s.StartOrphanCleanup()
	s.StartAFKChecker()
	if firstOrphan != s.orphanWorker.done || firstAFK != s.afkWorker.done {
		t.Fatal("duplicate worker launch")
	}
	s.StopMaintenance()
	for _, done := range []chan struct{}{firstOrphan, firstAFK} {
		select {
		case <-done:
		default:
			t.Fatal("worker not joined")
		}
	}
	s.StopMaintenance()
	s.StartOrphanCleanup()
	s.StartAFKChecker()
	if firstOrphan != s.orphanWorker.done || firstAFK != s.afkWorker.done {
		t.Fatal("terminal service restarted")
	}
}

type maintenanceBlockingChannelGetter struct {
	entered chan struct{}
	release chan struct{}
}

func (g maintenanceBlockingChannelGetter) GetByID(ctx context.Context, _ string) (*models.Channel, error) {
	close(g.entered)
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-g.release:
		return nil, context.Canceled
	}
}

func TestVoiceMaintenanceAFKStopCancelsLookup(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	defer close(release)
	s := &voiceService{states: map[string]*models.VoiceState{"user": {UserID: "user", ChannelID: "channel", LastActivity: time.Now().Add(-time.Hour)}}, channelGetter: maintenanceBlockingChannelGetter{entered: entered, release: release}}
	s.afkWorker.startContext(time.Millisecond, s.sweepAFKUsersContext)
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("AFK lookup never started")
	}
	done := make(chan struct{})
	go func() { s.StopMaintenance(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("AFK Stop did not cancel lookup")
	}
	if s.states["user"] == nil {
		t.Fatal("cancelled sweep removed voice state")
	}
}
