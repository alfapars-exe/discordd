package services

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

type delayedDMDecliner struct {
	repository.DMRepository
	started, release chan struct{}
}

func (r delayedDMDecliner) DeclinePending(ctx context.Context, id, user string) (bool, []string, []string, error) {
	close(r.started)
	select {
	case <-r.release:
	case <-ctx.Done():
		return false, nil, nil, ctx.Err()
	}
	return r.DMRepository.(repository.PendingDMDecliner).DeclinePending(ctx, id, user)
}

func (r delayedDMDecliner) AcceptPendingUnblocked(ctx context.Context, id string) (bool, error) {
	return r.DMRepository.(repository.PendingDMAccepter).AcceptPendingUnblocked(ctx, id)
}

func TestDMDeclineAfterConcurrentAcceptPreservesChannelAndEmitsNoDecline(t *testing.T) {
	db := newBotTestDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, id := range []string{"alice", "bob"} {
		if _, err := db.Conn.ExecContext(ctx, `INSERT INTO users(id,username,password_hash) VALUES(?,?,?)`, id, id, "x"); err != nil {
			t.Fatal(err)
		}
	}
	repo := repository.NewSQLiteDMRepo(db.Conn)
	channel := &models.DMChannel{User1ID: "alice", User2ID: "bob", Status: models.DMStatusPending}
	if err := repo.CreateChannel(ctx, channel); err != nil {
		t.Fatal(err)
	}
	if err := repo.SetInitiatedBy(ctx, channel.ID, "alice"); err != nil {
		t.Fatal(err)
	}
	f := newDMFixture()
	started, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }) })
	f.svc.(*dmService).dmRepo = delayedDMDecliner{DMRepository: repo, started: started, release: release}
	var declined atomic.Int32
	f.hub.BroadcastToUserFn = func(_ string, event ws.Event) {
		if event.Op == ws.OpDMRequestDecline {
			declined.Add(1)
		}
	}
	done := make(chan error, 1)
	go func() { done <- f.svc.DeclineRequest(ctx, "bob", channel.ID) }()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("decline did not reach transaction")
	}
	if err := f.svc.AcceptRequest(ctx, "bob", channel.ID); err != nil {
		t.Fatal(err)
	}
	once.Do(func() { close(release) })
	select {
	case err := <-done:
		if !errors.Is(err, pkg.ErrConflict) {
			t.Fatalf("decline error=%v", err)
		}
	case <-ctx.Done():
		t.Fatal("decline did not finish")
	}
	stored, err := repo.GetChannelByID(ctx, channel.ID)
	if err != nil || stored.Status != models.DMStatusAccepted {
		t.Fatalf("accepted channel=%+v err=%v", stored, err)
	}
	if declined.Load() != 0 {
		t.Fatal("losing decline broadcast an event")
	}
}
