package services

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
)

func TestApplicationRemovalFreshProofAndScopedRuntime(t *testing.T) {
	h, s, hub := boundAuthHarness(t)
	ctx := context.Background()
	login := sessionLogin(t, s, h.user.Username)
	if _, err := h.db.Conn.Exec(`INSERT INTO users(id,username,password_hash,is_bot,owner_user_id) VALUES('app','retiringapp','!disabled!',1,?)`, h.user.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := h.db.Conn.Exec(`INSERT INTO bot_tokens(id,bot_user_id,token_hash) VALUES('token','app','token-hash')`); err != nil {
		t.Fatal(err)
	}
	inv := &stubInvalidator{}
	users := &adminInvalStub{}
	voice := &testutil.MockVoiceDisconnecter{}
	s.SetOwnershipInvalidator(inv)
	s.SetUserCacheInvalidator(users)
	s.SetVoiceDisconnecter(voice)
	s.applicationRemoval = repository.NewSQLiteApplicationRemovalRepo(h.db.Conn)
	disconnected := ""
	hub.DisconnectUserFn = func(id string) { disconnected = id }
	_, codes := h.enroll(t)
	if err := s.RemoveApplication(ctx, h.user.ID, login.SessionID, "app", "wrong", ""); !errors.Is(err, pkg.ErrUnauthorized) {
		t.Fatal("password not required", err)
	}
	if err := s.RemoveApplication(ctx, h.user.ID, login.SessionID, "app", "current-password", ""); !errors.Is(err, ErrMFARequired) {
		t.Fatal("factor not required", err)
	}
	if disconnected != "" || len(inv.userCalls) != 0 {
		t.Fatal("failed proof changed runtime")
	}
	h.now += 301
	if err := s.RemoveApplication(ctx, h.user.ID, login.SessionID, "app", "current-password", codes[0]); err != nil {
		t.Fatal(err)
	}
	if disconnected != "app" || len(inv.userCalls) != 1 || inv.userCalls[0] != "app" || len(users.invalidated) != 1 || users.invalidated[0] != "app" || len(voice.DisconnectedIDs) != 1 || voice.DisconnectedIDs[0] != "app" {
		t.Fatal("retirement not scoped to application", disconnected, inv.userCalls, users.invalidated, voice.DisconnectedIDs)
	}
	if err := s.ValidateSession(ctx, h.user.ID, login.SessionID); err != nil {
		t.Fatal("bot removal ended owner session", err)
	}
	if err := s.RemoveApplication(ctx, h.user.ID, login.SessionID, "app", "current-password", codes[0]); err == nil {
		t.Fatal("recovery proof reused")
	}
}

func TestApplicationRemovalRejectsUnwiredRuntime(t *testing.T) {
	s := &authService{}
	if err := s.RemoveApplication(context.Background(), "owner", "sid", "app", "password", ""); err == nil {
		t.Fatal("unwired removal accepted")
	}
}

type applicationRemovalTransition func(context.Context, string, string, string, string, string, int64) error

func (f applicationRemovalTransition) Remove(ctx context.Context, actor, sid, hash, mfa, app string, now int64) error {
	return f(ctx, actor, sid, hash, mfa, app, now)
}

func TestApplicationRemovalFailureDoesNotDisconnect(t *testing.T) {
	for _, changedFactor := range []bool{false, true} {
		t.Run(map[bool]string{false: "failed write", true: "factor changed after proof"}[changedFactor], func(t *testing.T) {
			h, s, hub := boundAuthHarness(t)
			ctx := context.Background()
			login := sessionLogin(t, s, h.user.Username)
			if _, err := h.db.Conn.Exec(`INSERT INTO users(id,username,password_hash,is_bot,owner_user_id) VALUES('app','retiringapp','!disabled!',1,?)`, h.user.ID); err != nil {
				t.Fatal(err)
			}
			inv := &stubInvalidator{}
			users := &adminInvalStub{}
			voice := &testutil.MockVoiceDisconnecter{}
			s.SetOwnershipInvalidator(inv)
			s.SetUserCacheInvalidator(users)
			s.SetVoiceDisconnecter(voice)
			disconnects := 0
			observers := 0
			s.SetMusicRequesterRetirementObserver(musicRequesterObserverFunc(func(string) { observers++ }))
			hub.DisconnectUserFn = func(string) { disconnects++ }
			repo := repository.NewSQLiteApplicationRemovalRepo(h.db.Conn)
			s.applicationRemoval = applicationRemovalTransition(func(ctx context.Context, actor, sid, hash, mfa, app string, now int64) error {
				if !changedFactor {
					return errors.New("fixture write failure")
				}
				if _, err := h.db.Conn.Exec(`UPDATE account_mfa SET secret='changed-fixture' WHERE user_id=?`, actor); err != nil {
					return err
				}
				return repo.Remove(ctx, actor, sid, hash, mfa, app, now)
			})
			if err := s.RemoveApplication(ctx, h.user.ID, login.SessionID, "app", "current-password", ""); err == nil {
				t.Fatal("failed or stale-proof removal succeeded")
			}
			if observers != 0 || disconnects != 0 || len(inv.userCalls) != 0 || len(users.invalidated) != 0 || len(voice.DisconnectedIDs) != 0 {
				t.Fatal("failed removal changed runtime")
			}
			var active int
			if err := h.db.Conn.QueryRow(`SELECT COUNT(*) FROM users WHERE id='app' AND deleted_at IS NULL`).Scan(&active); err != nil || active != 1 {
				t.Fatal("failed removal changed application", err)
			}
		})
	}
}
