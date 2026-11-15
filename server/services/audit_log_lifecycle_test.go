package services

import (
	"context"
	"fmt"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
	"sync"
	"testing"
	"time"
)

type auditLifecycleRepo struct {
	repository.AuditLogRepository
	mu      sync.Mutex
	entries []models.AuditLog
}

func (r *auditLifecycleRepo) Insert(_ context.Context, e *models.AuditLog) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.entries = append(r.entries, *e)
	return nil
}
func auditLifecycleFixture() (*auditLogService, *auditLifecycleRepo) {
	repo := &auditLifecycleRepo{}
	hub := ws.NewHub()
	return NewAuditLogService(repo, nil, nil, hub, hub).(*auditLogService), repo
}
func TestAuditStopBeforeStartDrainsAcceptedEntries(t *testing.T) {
	s, repo := auditLifecycleFixture()
	s.Write(models.AuditLog{})
	done := make(chan struct{})
	go func() { s.Stop(); close(done) }()
	select {
	case <-done:
	case <-time.After(200 * time.Millisecond):
		s.Start()
		s.Stop()
		<-done
		t.Fatal("Stop before Start blocked")
	}
	repo.mu.Lock()
	defer repo.mu.Unlock()
	if len(repo.entries) != 1 {
		t.Fatalf("persisted=%d want 1", len(repo.entries))
	}
}
func TestAuditWriteAfterStopIsRejected(t *testing.T) {
	s, _ := auditLifecycleFixture()
	s.Start()
	s.Stop()
	s.Write(models.AuditLog{})
	if len(s.ch) != 0 {
		t.Fatal("stopped audit writer accepted an unowned entry")
	}
}

func TestAuditConcurrentStartStopOwnsOneWriterAndDrainsOnce(t *testing.T) {
	s, repo := auditLifecycleFixture()
	for i := 0; i < 64; i++ {
		s.Write(models.AuditLog{ServerID: fmt.Sprint(i)})
	}
	gate := make(chan struct{})
	var group sync.WaitGroup
	for i := 0; i < 32; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			<-gate
			s.Start()
			s.Stop()
			s.Start()
			s.Stop()
		}()
	}
	close(gate)
	done := make(chan struct{})
	go func() { group.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("concurrent lifecycle did not join")
	}
	repo.mu.Lock()
	defer repo.mu.Unlock()
	seen := map[string]bool{}
	for _, entry := range repo.entries {
		if seen[entry.ServerID] {
			t.Fatalf("duplicate persisted entry %s", entry.ServerID)
		}
		seen[entry.ServerID] = true
	}
	if len(seen) != 64 {
		t.Fatalf("persisted=%d want 64", len(seen))
	}
	s.Write(models.AuditLog{})
	if len(s.ch) != 0 {
		t.Fatal("terminal writer accepted new work")
	}
}
