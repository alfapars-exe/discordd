//go:build !windows && cgo && libsql_integration

package repository

import (
	"context"
	"errors"
	"io/fs"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/google/uuid"
)

// This integration test requires an explicitly disposable loopback libSQL DB.
func TestLibSQLAcceptDeclinePendingDMRace(t *testing.T) {
	dsn := os.Getenv("HICHAT_TEST_LIBSQL_DSN")
	if dsn == "" {
		t.Skip("set HICHAT_TEST_LIBSQL_DSN to a disposable loopback server")
	}
	u, err := url.Parse(dsn)
	if err != nil || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost" && u.Hostname() != "::1") {
		t.Fatal("test requires a disposable loopback libSQL server")
	}
	migrations, err := fs.Sub(database.EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatal(err)
	}
	db, err := database.New(dsn, migrations)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	accountA := "libsql-dm-a-" + uuid.NewString()
	accountB := "libsql-dm-b-" + uuid.NewString()
	for _, id := range []string{accountA, accountB} {
		if _, err := db.Conn.ExecContext(ctx, `INSERT INTO users(id,username,password_hash) VALUES(?,?,?)`, id, id, "test-only"); err != nil {
			t.Fatalf("create unique test account: %v", err)
		}
	}
	user1, user2 := accountA, accountB
	if strings.Compare(user1, user2) > 0 {
		user1, user2 = user2, user1
	}
	repo := NewSQLiteDMRepo(wrapForRepo(db))
	channel := &models.DMChannel{User1ID: user1, User2ID: user2, Status: models.DMStatusPending}
	if err := repo.CreateChannel(ctx, channel); err != nil {
		t.Fatalf("create pending channel: %v", err)
	}
	if err := repo.SetInitiatedBy(ctx, channel.ID, user1); err != nil {
		t.Fatalf("set request initiator: %v", err)
	}

	start := make(chan struct{})
	type acceptResult struct {
		changed bool
		err     error
	}
	type declineResult struct {
		changed bool
		err     error
	}
	accepted := make(chan acceptResult, 1)
	declined := make(chan declineResult, 1)
	go func() {
		<-start
		changed, err := repo.(PendingDMAccepter).AcceptPendingUnblocked(ctx, channel.ID)
		accepted <- acceptResult{changed, err}
	}()
	go func() {
		<-start
		changed, _, _, err := repo.(PendingDMDecliner).DeclinePending(ctx, channel.ID, user2)
		declined <- declineResult{changed, err}
	}()
	close(start)

	acceptOutcome, declineOutcome := <-accepted, <-declined
	if acceptOutcome.err != nil {
		t.Fatalf("accept transaction failed: %v", acceptOutcome.err)
	}
	if declineOutcome.err != nil {
		t.Fatalf("decline transaction failed: %v", declineOutcome.err)
	}
	if acceptOutcome.changed == declineOutcome.changed {
		t.Fatalf("expected exactly one winner: accept=%+v decline=%+v", acceptOutcome, declineOutcome)
	}
	row, getErr := repo.GetChannelByID(ctx, channel.ID)
	if acceptOutcome.changed {
		if getErr != nil || row.Status != models.DMStatusAccepted {
			t.Fatalf("accepted winner lost channel: row=%+v err=%v", row, getErr)
		}
	} else if !errors.Is(getErr, pkg.ErrNotFound) {
		t.Fatalf("decline winner left channel behind: row=%+v err=%v", row, getErr)
	}
}
