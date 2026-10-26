package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

type dmCreateBlockBarrier struct {
	repository.DMRepository
	before func()
}

func (r dmCreateBlockBarrier) CreateChannel(ctx context.Context, ch *models.DMChannel) error {
	r.before()
	return r.DMRepository.CreateChannel(ctx, ch)
}

func (r dmCreateBlockBarrier) CreateChannelUnblocked(ctx context.Context, ch *models.DMChannel) (bool, error) {
	r.before()
	if writer, ok := r.DMRepository.(interface {
		CreateChannelUnblocked(context.Context, *models.DMChannel) (bool, error)
	}); ok {
		return writer.CreateChannelUnblocked(ctx, ch)
	}
	return true, r.DMRepository.CreateChannel(ctx, ch)
}

// A deterministic interleaving of two real requests: block commits after the
// service precheck but before the DM INSERT, against the real repository/schema.
func TestDMChannelConcurrentBlockAfterPrecheckPreventsInsertAndEvent(t *testing.T) {
	db := newBotTestDB(t)
	for _, id := range []string{"alice", "bob"} {
		if _, err := db.Conn.Exec(`INSERT INTO users(id,username,password_hash) VALUES(?,?,?)`, id, id, "hash"); err != nil {
			t.Fatal(err)
		}
	}
	repo := repository.NewSQLiteDMRepo(db.Conn)
	blocks := repository.NewSQLiteFriendshipRepo(db.Conn).(repository.AtomicBlockWriter)
	f := newDMFixture()
	f.users.GetByIDFn = func(_ context.Context, id string) (*models.User, error) {
		return &models.User{ID: id, DMPrivacy: "everyone"}, nil
	}
	f.block.IsBlockedFn = func(context.Context, string, string) (bool, error) { return false, nil }
	f.svc.(*dmService).dmRepo = dmCreateBlockBarrier{DMRepository: repo, before: func() {
		now := time.Now().UTC()
		if _, err := blocks.CreateBlockAtomic(context.Background(), &models.Friendship{ID: "late-block", UserID: "bob", FriendID: "alice", Status: models.FriendshipStatusBlocked, CreatedAt: now, UpdatedAt: now}); err != nil {
			t.Fatal(err)
		}
	}}
	events := 0
	f.hub.BroadcastToUserFn = func(string, ws.Event) { events++ }
	channel, err := f.svc.GetOrCreateChannel(context.Background(), "alice", "bob")
	if !errors.Is(err, pkg.ErrForbidden) || channel != nil || events != 0 {
		t.Fatalf("channel=%v err=%v events=%d", channel, err, events)
	}
	var count int
	if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM dm_channels`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("channels=%d err=%v", count, err)
	}
}
