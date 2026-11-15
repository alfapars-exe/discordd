package services

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
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

type auditBlockedPersistence struct {
	auditLifecycleRepo
	entered     chan struct{}
	release     chan struct{}
	enteredOnce sync.Once
}

func (r *auditBlockedPersistence) Insert(ctx context.Context, entry *models.AuditLog) error {
	r.enteredOnce.Do(func() { close(r.entered) })
	<-r.release
	return r.auditLifecycleRepo.Insert(ctx, entry)
}
func TestAuditStopJoinsActivePersistenceAndQueuedDrain(t *testing.T) {
	repo := &auditBlockedPersistence{entered: make(chan struct{}), release: make(chan struct{})}
	hub := ws.NewHub()
	s := NewAuditLogService(repo, nil, nil, hub, hub)
	var release sync.Once
	unblock := func() { release.Do(func() { close(repo.release) }) }
	t.Cleanup(func() { unblock(); s.Stop() })
	s.Start()
	s.Write(models.AuditLog{ServerID: "active"})
	select {
	case <-repo.entered:
	case <-time.After(time.Second):
		t.Fatal("writer did not enter persistence")
	}
	s.Write(models.AuditLog{ServerID: "queued"})
	stopped := make(chan struct{})
	go func() { s.Stop(); close(stopped) }()
	select {
	case <-stopped:
		t.Fatal("Stop returned with persistence still active")
	case <-time.After(50 * time.Millisecond):
	}
	unblock()
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("Stop did not join persistence/drain")
	}
	repo.mu.Lock()
	defer repo.mu.Unlock()
	if len(repo.entries) != 2 || repo.entries[0].ServerID != "active" || repo.entries[1].ServerID != "queued" {
		t.Fatalf("drained entries=%+v", repo.entries)
	}
}

// Snapshot enrichment belongs to the writer, never the moderation request.
type auditBlockingUserLookup struct {
	repository.UserRepository
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (u *auditBlockingUserLookup) GetByID(ctx context.Context, id string) (*models.User, error) {
	u.once.Do(func() { close(u.entered) })
	select {
	case <-u.release:
		return &models.User{ID: id, Username: "snapshot-user"}, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
func TestAuditWriteDoesNotWaitForSnapshotLookup(t *testing.T) {
	repo := &auditLifecycleRepo{}
	users := &auditBlockingUserLookup{entered: make(chan struct{}), release: make(chan struct{})}
	hub := ws.NewHub()
	s := NewAuditLogService(repo, users, nil, hub, hub)
	var release sync.Once
	unblock := func() { release.Do(func() { close(users.release) }) }
	t.Cleanup(func() { unblock(); s.Stop() })
	s.Start()
	actor := "actor"
	written := make(chan struct{})
	go func() { s.Write(models.AuditLog{ActorUserID: &actor}); close(written) }()
	select {
	case <-users.entered:
	case <-time.After(time.Second):
		t.Fatal("snapshot lookup never started")
	}
	select {
	case <-written:
	case <-time.After(100 * time.Millisecond):
		unblock()
		<-written
		t.Fatal("audit Write blocked the request on a user lookup")
	}
	unblock()
	s.Stop()
	repo.mu.Lock()
	defer repo.mu.Unlock()
	if len(repo.entries) != 1 || repo.entries[0].ActorSnapshot == nil || repo.entries[0].ActorSnapshot.Username != "snapshot-user" {
		t.Fatalf("snapshot not persisted: %+v", repo.entries)
	}
}

func TestAuditWriteOwnsProvidedSnapshotAndIdentityValues(t *testing.T) {
	s, repo := auditLifecycleFixture()
	actor, target := "actor-before", "target-before"
	actorSnapshot := &models.UserSnapshot{ID: actor, Username: "actor-name-before"}
	targetSnapshot := &models.UserSnapshot{ID: target, Username: "target-name-before"}
	s.Write(models.AuditLog{ActorUserID: &actor, TargetUserID: &target, ActorSnapshot: actorSnapshot, TargetSnapshot: targetSnapshot})
	actor, target = "actor-after", "target-after"
	actorSnapshot.Username, targetSnapshot.Username = "actor-name-after", "target-name-after"
	s.Stop()
	repo.mu.Lock()
	defer repo.mu.Unlock()
	if len(repo.entries) != 1 {
		t.Fatalf("persisted=%d", len(repo.entries))
	}
	e := repo.entries[0]
	if *e.ActorUserID != "actor-before" || *e.TargetUserID != "target-before" || e.ActorSnapshot.Username != "actor-name-before" || e.TargetSnapshot.Username != "target-name-before" || e.Metadata != "{}" {
		t.Fatalf("queued audit entry changed with caller values: %+v actor=%+v target=%+v", e, e.ActorSnapshot, e.TargetSnapshot)
	}
}

func TestAuditDroppedAndStoppedEventsDoNotReadUsers(t *testing.T) {
	s, repo := auditLifecycleFixture() // nil user repository detects any lookup.
	for range cap(s.ch) {
		s.Write(models.AuditLog{})
	}
	actor := "dropped-actor"
	s.Write(models.AuditLog{ActorUserID: &actor})
	s.Stop()
	s.Write(models.AuditLog{ActorUserID: &actor})
	repo.mu.Lock()
	defer repo.mu.Unlock()
	if len(repo.entries) != cap(s.ch) {
		t.Fatalf("persisted=%d want=%d", len(repo.entries), cap(s.ch))
	}
}

type auditNotifyingPersistence struct {
	auditLifecycleRepo
	persisted chan struct{}
}

func (r *auditNotifyingPersistence) Insert(ctx context.Context, entry *models.AuditLog) error {
	err := r.auditLifecycleRepo.Insert(ctx, entry)
	close(r.persisted)
	return err
}
func TestAuditSnapshotDeadlineStillPersistsIdentityFallback(t *testing.T) {
	repo := &auditNotifyingPersistence{persisted: make(chan struct{})}
	users := &auditBlockingUserLookup{entered: make(chan struct{}), release: make(chan struct{})}
	hub := ws.NewHub()
	s := NewAuditLogService(repo, users, nil, hub, hub)
	t.Cleanup(func() { close(users.release); s.Stop() })
	s.Start()
	actor := "snapshot-unavailable"
	s.Write(models.AuditLog{ActorUserID: &actor})
	select {
	case <-repo.persisted:
	case <-time.After(3 * time.Second):
		t.Fatal("snapshot storage stall prevented audit persistence")
	}
	s.Stop()
	repo.mu.Lock()
	defer repo.mu.Unlock()
	if len(repo.entries) != 1 || repo.entries[0].ActorSnapshot != nil || *repo.entries[0].ActorUserID != actor {
		t.Fatalf("identity fallback lost: %+v", repo.entries)
	}
}
