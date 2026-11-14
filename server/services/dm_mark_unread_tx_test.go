package services

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

type markUnreadTxRunnerFunc func(context.Context, func(*repository.DMTxRepos) error) error

func (f markUnreadTxRunnerFunc) InTx(ctx context.Context, fn func(*repository.DMTxRepos) error) error {
	return f(ctx, fn)
}

func TestDMMarkUnreadFrom_ChannelFirstTransaction(t *testing.T) {
	for _, failure := range []string{"", "membership", "lock", "write", "commit"} {
		t.Run("failure="+failure, func(t *testing.T) {
			f := newDMFixture()
			acceptedFriendsFixture(f)
			injected := errors.New("injected failure")
			var steps []string
			f.dmRead.MarkUnreadFromFn = func(context.Context, string, string, string) (int, error) {
				t.Fatal("used non-transactional read repository")
				return 0, nil
			}
			txRead := &testutil.MockDMReadRepo{}
			txRead.MarkUnreadFromFn = func(_ context.Context, userID, channelID, messageID string) (int, error) {
				if !reflect.DeepEqual(steps, []string{"begin", "lock"}) {
					t.Fatalf("read row mutated before channel lock: %v", steps)
				}
				if userID != "bob" || channelID != "ch-1" || messageID != "m-2" {
					t.Fatalf("unexpected arguments: %s %s %s", userID, channelID, messageID)
				}
				steps = append(steps, "write")
				if failure == "write" {
					return 0, injected
				}
				return 3, nil
			}
			f.svc.(*dmService).txRunner = markUnreadTxRunnerFunc(func(ctx context.Context, fn func(*repository.DMTxRepos) error) error {
				steps = append(steps, "begin")
				err := fn(&repository.DMTxRepos{DMRead: txRead, LockChannel: func(_ context.Context, id string) error {
					if id != "ch-1" {
						t.Fatalf("locked wrong channel %s", id)
					}
					steps = append(steps, "lock")
					if failure == "lock" {
						return injected
					}
					return nil
				}})
				if err != nil {
					return err
				}
				steps = append(steps, "commit")
				if failure == "commit" {
					return injected
				}
				return nil
			})
			f.hub.BroadcastToUserFn = func(userID string, event ws.Event) {
				if failure != "" || !reflect.DeepEqual(steps, []string{"begin", "lock", "write", "commit"}) {
					t.Fatalf("broadcast before successful commit: %v", steps)
				}
				if userID != "bob" || event.Op != ws.OpDMRead || event.Data.(map[string]any)["unread_count"] != 3 {
					t.Fatalf("unexpected broadcast: %s %+v", userID, event)
				}
				steps = append(steps, "broadcast")
			}
			userID := "bob"
			if failure == "membership" {
				userID = "outsider"
			}
			count, err := f.svc.MarkUnreadFrom(context.Background(), userID, "ch-1", "m-2")
			switch {
			case failure == "membership":
				if !errors.Is(err, pkg.ErrForbidden) || count != 0 || len(steps) != 0 {
					t.Fatalf("unauthorized mutation: count=%d err=%v steps=%v", count, err, steps)
				}
			case failure != "":
				if !errors.Is(err, injected) || count != 0 {
					t.Fatalf("failed transaction: count=%d err=%v", count, err)
				}
			case err != nil || count != 3 || !reflect.DeepEqual(steps, []string{"begin", "lock", "write", "commit", "broadcast"}):
				t.Fatalf("count=%d err=%v steps=%v", count, err, steps)
			}
		})
	}
}

// Uses SQLite by default and the isolated PostgreSQL fixture when
// HICHAT_TEST_POSTGRES_DSN is set. Both serial orders must preserve the count.
func TestDMMarkUnreadFrom_ConcurrentSend(t *testing.T) {
	db := newDMSendTestDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	for _, id := range []string{"alice", "bob"} {
		if _, err := db.Conn.ExecContext(ctx, `INSERT INTO users(id,username,password_hash) VALUES(?,?,'x')`, id, id); err != nil {
			t.Fatal(err)
		}
	}
	repo := repository.NewSQLiteDMRepo(db.Conn)
	ch := &models.DMChannel{User1ID: "alice", User2ID: "bob", Status: models.DMStatusAccepted}
	if err := repo.CreateChannel(ctx, ch); err != nil {
		t.Fatal(err)
	}
	svc := NewDMService(nil, repo, repository.NewSQLiteUserRepo(db.Conn), &testutil.MockBroadcaster{}, &testutil.MockBlockChecker{}, nil, nil,
		repository.NewSQLiteDMReadRepo(db.Conn), repository.NewSQLiteNotificationRepo(db.Conn), repository.NewDMMessageTxRunner(db.Conn), nil, nil, nil, nil, nil)
	anchor, err := svc.SendMessage(ctx, "alice", ch.ID, &models.CreateDMMessageRequest{Content: "anchor"})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 20; i++ {
		if err := svc.MarkRead(ctx, "bob", ch.ID, nil); err != nil {
			t.Fatal(err)
		}
		start := make(chan struct{})
		errs := make(chan error, 2)
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			_, err := svc.MarkUnreadFrom(ctx, "bob", ch.ID, anchor.ID)
			errs <- err
		}()
		go func() {
			defer wg.Done()
			<-start
			_, err := svc.SendMessage(ctx, "alice", ch.ID, &models.CreateDMMessageRequest{Content: "concurrent message"})
			errs <- err
		}()
		close(start)
		wg.Wait()
		close(errs)
		for err := range errs {
			if err != nil {
				t.Fatalf("iteration %d: concurrent send/mark unread failed: %v", i, err)
			}
		}
		var count int
		if err := db.Conn.QueryRowContext(ctx, `SELECT unread_count FROM dm_reads WHERE user_id='bob' AND dm_channel_id=?`, ch.ID).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != i+2 {
			t.Fatalf("iteration %d: unread count=%d, want %d", i, count, i+2)
		}
	}
}
