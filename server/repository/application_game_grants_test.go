package repository

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func TestGameGrantOwnershipRevisionAndIsolation(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	r := NewBotRepository(wrapForRepo(db))
	execSeed(t, db, []seedStmt{{`INSERT INTO users(id,username,password_hash) VALUES('owner','owner','x'),('alice','alice','x'),('bob','bob','x')`, nil},
		{`INSERT INTO users(id,username,password_hash,is_bot,owner_user_id) VALUES('game','gamebot','x',1,'owner'),('legacy','legacybot','x',1,'owner')`, nil}})
	for _, actor := range []string{"alice", "game", "missing"} {
		if err := r.RegisterGameIdentity(ctx, actor, "game"); !errors.Is(err, pkg.ErrNotFound) {
			t.Fatalf("actor %s registration=%v", actor, err)
		}
	}
	if err := r.RegisterGameIdentity(ctx, "owner", "game"); err != nil {
		t.Fatal(err)
	}
	if err := r.RegisterGameIdentity(ctx, "owner", "game"); err != nil {
		t.Fatalf("idempotent registration: %v", err)
	}
	for _, target := range []string{"legacy", "alice", "missing"} {
		if _, err := r.ChangeGameGrant(ctx, "alice", target, 0, true, false); !errors.Is(err, pkg.ErrNotFound) {
			t.Fatalf("target %s grant=%v", target, err)
		}
	}
	if _, err := r.ChangeGameGrant(ctx, "game", "game", 0, true, false); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("bot authorizer=%v", err)
	}
	g, err := r.ChangeGameGrant(ctx, "alice", "game", 0, true, false)
	if err != nil {
		t.Fatal(err)
	}
	if g.Revision != 1 || !g.MessagingEnabled || g.RevokedAt != nil {
		t.Fatalf("new=%+v", g)
	}
	if _, err := r.ChangeGameGrant(ctx, "alice", "game", 0, true, false); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("duplicate=%v", err)
	}
	if _, err := r.ChangeGameGrant(ctx, "bob", "game", 1, false, true); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("foreign revoke=%v", err)
	}
	items, err := r.ListGameGrants(ctx, "bob")
	if err != nil || len(items) != 0 {
		t.Fatalf("other account leaked grants: %+v %v", items, err)
	}
	g, err = r.ChangeGameGrant(ctx, "alice", "game", 1, false, false)
	if err != nil || g.Revision != 2 || g.MessagingEnabled {
		t.Fatalf("toggle=%+v %v", g, err)
	}
	if _, err := r.ChangeGameGrant(ctx, "alice", "game", 1, true, false); !errors.Is(err, pkg.ErrConflict) {
		t.Fatalf("stale=%v", err)
	}
	g, err = r.ChangeGameGrant(ctx, "alice", "game", 2, false, true)
	if err != nil || g.RevokedAt == nil || g.Revision != 3 {
		t.Fatalf("revoke=%+v %v", g, err)
	}
	g, err = r.ChangeGameGrant(ctx, "alice", "game", 3, true, false)
	if err != nil || g.RevokedAt != nil || !g.MessagingEnabled || g.Revision != 4 {
		t.Fatalf("explicit reauthorize=%+v %v", g, err)
	}
	if _, err = db.Conn.ExecContext(ctx, `UPDATE users SET deleted_at=1 WHERE id='game'`); err != nil {
		t.Fatal(err)
	}
	items, err = r.ListGameGrants(ctx, "alice")
	if err != nil || len(items) != 0 {
		t.Fatalf("deleted app leaked: %+v %v", items, err)
	}
}

func TestGameGrantEditsAndAttachmentCompletionCannotBypass(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	r := NewBotRepository(wrapForRepo(db))
	dm := NewSQLiteDMRepo(wrapForRepo(db))
	execSeed(t, db, []seedStmt{{`INSERT INTO users(id,username,password_hash) VALUES('owner','owner','x'),('alice','alice','x')`, nil},
		{`INSERT INTO users(id,username,password_hash,is_bot,owner_user_id) VALUES('game','gamebot','x',1,'owner')`, nil}})
	ch := newDMChannel(t, ctx, dm, "alice", "game", models.DMStatusAccepted)
	original := "original-ciphertext"
	device := "device"
	old := &models.DMMessage{UserID: "game", DMChannelID: ch.ID, EncryptionVersion: 1, Ciphertext: &original, SenderDeviceID: &device}
	if err := dm.CreateMessage(ctx, old); err != nil {
		t.Fatal(err)
	}
	if err := r.RegisterGameIdentity(ctx, "owner", "game"); err != nil {
		t.Fatal(err)
	}
	replacement := "replacement-ciphertext"
	edit := &models.UpdateDMMessageRequest{EncryptionVersion: 1, Ciphertext: &replacement, SenderDeviceID: &device}
	if err := dm.UpdateMessage(ctx, old.ID, edit); !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("newly-registered old message edit bypass=%v", err)
	}
	if _, err := r.ChangeGameGrant(ctx, "alice", "game", 0, true, false); err != nil {
		t.Fatal(err)
	}
	if err := dm.UpdateMessage(ctx, old.ID, edit); err != nil {
		t.Fatalf("enabled edit=%v", err)
	}
	attachment := func() error {
		return dm.CreateAttachment(ctx, &models.DMAttachment{DMMessageID: old.ID, Filename: "encrypted.bin", FileURL: "/api/uploads/game-encrypted.bin"})
	}
	if err := attachment(); err != nil {
		t.Fatalf("enabled attachment=%v", err)
	}
	assertRetained := func() {
		t.Helper()
		stored, err := dm.GetMessageByID(ctx, old.ID)
		if err != nil || stored.Ciphertext == nil || *stored.Ciphertext != replacement || stored.ApplicationID != nil {
			t.Fatalf("forbidden edit changed ciphertext/origin: %+v %v", stored, err)
		}
	}
	for _, revoke := range []bool{false, true} {
		expected := int64(1)
		if revoke {
			expected = 2
		}
		if _, err := r.ChangeGameGrant(ctx, "alice", "game", expected, false, revoke); err != nil {
			t.Fatal(err)
		}
		bad := "forbidden-replacement"
		if err := dm.UpdateMessage(ctx, old.ID, &models.UpdateDMMessageRequest{EncryptionVersion: 1, Ciphertext: &bad, SenderDeviceID: &device}); !errors.Is(err, pkg.ErrForbidden) {
			t.Fatalf("disabled/revoked edit bypass=%v", err)
		}
		if err := attachment(); !errors.Is(err, pkg.ErrForbidden) {
			t.Fatalf("disabled/revoked attachment bypass=%v", err)
		}
		assertRetained()
	}
	attachments, err := dm.GetAttachmentsByMessageIDs(ctx, []string{old.ID})
	if err != nil || len(attachments[old.ID]) != 1 {
		t.Fatalf("forbidden attachment persisted: %+v %v", attachments, err)
	}
	if err := dm.DeleteMessage(ctx, old.ID); err != nil {
		t.Fatalf("revocation prevented deletion: %v", err)
	}
}

func TestGameGrantPostgresSendRevokeSerialization(t *testing.T) {
	db := newTestDB(t)
	if !database.IsPostgres(db.Conn) {
		t.Skip("requires a local PostgreSQL pooled-connection fixture")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	r := NewBotRepository(wrapForRepo(db))
	dm := NewSQLiteDMRepo(wrapForRepo(db))
	execSeed(t, db, []seedStmt{{`INSERT INTO users(id,username,password_hash) VALUES('owner','owner','x'),('alice','alice','x')`, nil},
		{`INSERT INTO users(id,username,password_hash,is_bot,owner_user_id) VALUES('game','gamebot','x',1,'owner')`, nil}})
	ch := newDMChannel(t, ctx, dm, "alice", "game", models.DMStatusAccepted)
	if err := r.RegisterGameIdentity(ctx, "owner", "game"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.ChangeGameGrant(ctx, "alice", "game", 0, true, false); err != nil {
		t.Fatal(err)
	}
	release := make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })
	written := make(chan int, 1)
	sent := make(chan error, 1)
	revoked := make(chan error, 1)
	content := "authorized before revocation"
	go func() {
		sent <- NewDMMessageTxRunner(db.Conn).InTx(ctx, func(tx *DMTxRepos) error {
			if err := tx.DM.CreateMessage(ctx, &models.DMMessage{UserID: "game", DMChannelID: ch.ID, Content: &content}); err != nil {
				return err
			}
			var pid int
			if err := tx.DM.(*sqliteDMRepo).db.QueryRowContext(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
				return err
			}
			written <- pid
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		})
	}()
	var senderPID int
	select {
	case senderPID = <-written:
	case err := <-sent:
		t.Fatalf("send did not acquire lock: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	go func() { _, err := r.ChangeGameGrant(ctx, "alice", "game", 1, false, true); revoked <- err }()
	// Observe the database's actual wait graph, rather than assuming a goroutine
	// started or relying on a small sleep as proof of a cross-connection lock.
	deadline := time.Now().Add(5 * time.Second)
	observed := false
	for time.Now().Before(deadline) {
		select {
		case err := <-revoked:
			t.Fatalf("revoke acknowledged while send was uncommitted: %v", err)
		default:
		}
		if err := db.Conn.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ? = ANY(pg_blocking_pids(pid)))`, senderPID).Scan(&observed); err != nil {
			t.Fatal(err)
		}
		if observed {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !observed {
		t.Fatal("PostgreSQL did not report revoke waiting on the sender transaction")
	}
	once.Do(func() { close(release) })
	if err := <-sent; err != nil {
		t.Fatalf("authorized prior send=%v", err)
	}
	if err := <-revoked; err != nil {
		t.Fatalf("revoke after commit=%v", err)
	}
	err := NewDMMessageTxRunner(db.Conn).InTx(ctx, func(tx *DMTxRepos) error {
		return tx.DM.CreateMessage(ctx, &models.DMMessage{UserID: "game", DMChannelID: ch.ID, Content: &content})
	})
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("send after revoke=%v", err)
	}
}

func TestGameGrantConcurrentCASOnlyOneWins(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	r := NewBotRepository(wrapForRepo(db))
	execSeed(t, db, []seedStmt{{`INSERT INTO users(id,username,password_hash) VALUES('owner','owner','x'),('alice','alice','x')`, nil},
		{`INSERT INTO users(id,username,password_hash,is_bot,owner_user_id) VALUES('game','gamebot','x',1,'owner')`, nil}})
	if err := r.RegisterGameIdentity(ctx, "owner", "game"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.ChangeGameGrant(ctx, "alice", "game", 0, true, false); err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := r.ChangeGameGrant(ctx, "alice", "game", 1, false, false)
			results <- err
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	success, conflict := 0, 0
	for err := range results {
		switch {
		case err == nil:
			success++
		case errors.Is(err, pkg.ErrConflict):
			conflict++
		default:
			t.Fatal(err)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatalf("success=%d conflict=%d", success, conflict)
	}
}

func TestGameGrantSharedDMSendCannotBypassAndPreservesCiphertext(t *testing.T) {
	db := newTestDB(t)
	ctx := context.Background()
	r := NewBotRepository(wrapForRepo(db))
	dm := NewSQLiteDMRepo(wrapForRepo(db))
	execSeed(t, db, []seedStmt{{`INSERT INTO users(id,username,password_hash) VALUES('owner','owner','x'),('alice','alice','x'),('bob','bob','x')`, nil},
		{`INSERT INTO users(id,username,password_hash,is_bot,owner_user_id) VALUES('game','gamebot','x',1,'owner'),('legacy','legacybot','x',1,'owner')`, nil}})
	gameChannel := newDMChannel(t, ctx, dm, "alice", "game", models.DMStatusAccepted)
	otherChannel := newDMChannel(t, ctx, dm, "bob", "game", models.DMStatusAccepted)
	legacyChannel := newDMChannel(t, ctx, dm, "alice", "legacy", models.DMStatusAccepted)
	if err := r.RegisterGameIdentity(ctx, "owner", "game"); err != nil {
		t.Fatal(err)
	}
	cipher, device, metadata := "opaque-ciphertext", "game-device", "opaque-metadata"
	send := func(sender, channel string) (*models.DMMessage, error) {
		forged := "untrusted-origin"
		m := &models.DMMessage{UserID: sender, DMChannelID: channel, EncryptionVersion: 1, Ciphertext: &cipher, SenderDeviceID: &device, E2EEMetadata: &metadata, ApplicationID: &forged}
		err := NewDMMessageTxRunner(db.Conn).InTx(ctx, func(tx *DMTxRepos) error { return tx.DM.CreateMessage(ctx, m) })
		return m, err
	}
	if _, err := send("game", gameChannel.ID); !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("missing grant bypass=%v", err)
	}
	if _, err := r.ChangeGameGrant(ctx, "alice", "game", 0, true, false); err != nil {
		t.Fatal(err)
	}
	m, err := send("game", gameChannel.ID)
	if err != nil {
		t.Fatal(err)
	}
	if m.ApplicationID == nil || *m.ApplicationID != "game" {
		t.Fatalf("send response origin not server-derived: %+v", m)
	}
	stored, err := dm.GetMessageByID(ctx, m.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Content != nil || stored.EncryptionVersion != 1 || stored.Ciphertext == nil || *stored.Ciphertext != cipher || stored.SenderDeviceID == nil || *stored.SenderDeviceID != device || stored.E2EEMetadata == nil || *stored.E2EEMetadata != metadata {
		t.Fatalf("ciphertext changed: %+v", stored)
	}
	if stored.ApplicationID == nil || *stored.ApplicationID != "game" {
		t.Fatalf("stored origin=%+v", stored.ApplicationID)
	}
	if err := dm.PinMessage(ctx, m.ID); err != nil {
		t.Fatal(err)
	}
	for name, load := range map[string]func() ([]models.DMMessage, error){
		"history": func() ([]models.DMMessage, error) { return dm.GetMessages(ctx, gameChannel.ID, "", 20) },
		"around": func() ([]models.DMMessage, error) {
			messages, _, _, err := dm.GetMessagesAround(ctx, gameChannel.ID, m.ID, 20)
			return messages, err
		},
		"pins": func() ([]models.DMMessage, error) { return dm.GetPinnedMessages(ctx, gameChannel.ID) },
	} {
		rows, err := load()
		if err != nil || len(rows) != 1 || rows[0].ApplicationID == nil || *rows[0].ApplicationID != "game" {
			t.Fatalf("%s origin lost: %+v %v", name, rows, err)
		}
	}
	if _, err := send("game", otherChannel.ID); !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("foreign recipient bypass=%v", err)
	}
	if _, err := r.ChangeGameGrant(ctx, "alice", "game", 1, false, false); err != nil {
		t.Fatal(err)
	}
	if _, err := send("game", gameChannel.ID); !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("disabled bypass=%v", err)
	}
	if _, err := r.ChangeGameGrant(ctx, "alice", "game", 2, false, true); err != nil {
		t.Fatal(err)
	}
	if _, err := send("game", gameChannel.ID); !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("revoked bypass=%v", err)
	}
	legacy, err := send("legacy", legacyChannel.ID)
	if err != nil {
		t.Fatalf("legacy bot behavior changed: %v", err)
	}
	if legacy.ApplicationID != nil {
		t.Fatal("non-game sender forged application origin")
	}
	if err := r.RegisterGameIdentity(ctx, "owner", "legacy"); err != nil {
		t.Fatal(err)
	}
	old, err := dm.GetMessageByID(ctx, legacy.ID)
	if err != nil || old.ApplicationID != nil {
		t.Fatalf("historical message inferred from current type: %+v %v", old, err)
	}
	if _, err := send("alice", gameChannel.ID); err != nil {
		t.Fatalf("human reply behavior changed: %v", err)
	}
	var count int
	if err := db.Conn.QueryRowContext(ctx, `SELECT COUNT(*) FROM dm_messages WHERE user_id='game'`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("rejected game sends persisted: %d %v", count, err)
	}
}
