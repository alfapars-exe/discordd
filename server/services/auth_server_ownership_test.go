package services

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

func TestOwnershipTransferFailsClosedWithoutSecurityWiring(t *testing.T) {
	// No credential access, database mutation or broadcast may occur when
	// production dependencies have not all been supplied.
	s := &authService{}
	server, err := s.TransferServerOwnership(context.Background(), "actor", "sid", "server", "target", "password", "")
	if err == nil || server != nil {
		t.Fatalf("unwired transfer = %v, %v; want failure", server, err)
	}
}

type ownershipTransition func(context.Context, string, string, string, string, string, string, int64) (*models.Server, error)

func (f ownershipTransition) Transfer(ctx context.Context, actor, sid, hash, mfa, serverID, target string, now int64) (*models.Server, error) {
	return f(ctx, actor, sid, hash, mfa, serverID, target, now)
}

func TestOwnershipTransferProofCommitAndRuntime(t *testing.T) {
	for _, scenario := range []string{"success", "audit failure", "factor race", "password race", "revoked session"} {
		t.Run(scenario, func(t *testing.T) {
			h, s, hub := boundAuthHarness(t)
			ctx := context.Background()
			login := sessionLogin(t, s, h.user.Username)
			target := &models.User{Username: "handoff_target", PasswordHash: "unused", Status: models.UserStatusOffline}
			if err := s.userRepo.Create(ctx, target); err != nil {
				t.Fatal(err)
			}
			for _, q := range []string{
				`INSERT INTO servers(id,name,owner_id) VALUES('handoff','Handoff',?)`,
				`INSERT INTO server_members(server_id,user_id) VALUES('handoff',?)`,
				`INSERT INTO roles(id,server_id,name,is_owner,permissions) VALUES('handoff-owner','handoff','Owner',1,512)`,
			} {
				var err error
				if q[len(q)-2:] == "?)" {
					_, err = h.db.Conn.Exec(q, h.user.ID)
				} else {
					_, err = h.db.Conn.Exec(q)
				}
				if err != nil {
					t.Fatal(err)
				}
			}
			if _, err := h.db.Conn.Exec(`INSERT INTO server_members(server_id,user_id) VALUES('handoff',?)`, target.ID); err != nil {
				t.Fatal(err)
			}
			if _, err := h.db.Conn.Exec(`INSERT INTO user_roles(user_id,role_id,server_id) VALUES(?,'handoff-owner','handoff')`, h.user.ID); err != nil {
				t.Fatal(err)
			}
			inv := &stubInvalidator{}
			s.SetOwnershipInvalidator(inv)
			events := 0
			hub.BroadcastToServerFn = func(id string, event ws.Event) {
				events++
				updated, ok := event.Data.(*models.Server)
				if id != "handoff" || event.Op != ws.OpServerUpdate || !ok || updated.OwnerID != target.ID || inv.allCount != 1 {
					t.Fatal("incorrect or premature runtime update")
				}
				var owner string
				if err := h.db.Conn.QueryRow(`SELECT owner_id FROM servers WHERE id='handoff'`).Scan(&owner); err != nil || owner != target.ID {
					t.Fatal("event before durable commit", err)
				}
			}
			repo := repository.NewSQLiteServerOwnershipRepo(h.db.Conn)
			s.serverOwnership = repo
			_, codes := h.enroll(t)
			if _, err := s.TransferServerOwnership(ctx, h.user.ID, login.SessionID, "handoff", target.ID, "wrong", ""); !errors.Is(err, pkg.ErrUnauthorized) {
				t.Fatal("wrong password accepted", err)
			}
			if _, err := s.TransferServerOwnership(ctx, h.user.ID, login.SessionID, "handoff", target.ID, "current-password", ""); !errors.Is(err, ErrMFARequired) {
				t.Fatal("missing factor accepted", err)
			}
			if events != 0 || inv.allCount != 0 {
				t.Fatal("failed proof changed runtime")
			}
			h.now += 301
			if scenario != "success" {
				s.serverOwnership = ownershipTransition(func(ctx context.Context, actor, sid, hash, mfa, serverID, target string, now int64) (*models.Server, error) {
					var err error
					switch scenario {
					case "audit failure":
						_, err = h.db.Conn.Exec(`CREATE TRIGGER reject_transfer_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT,'fixture'); END`)
					case "factor race":
						_, err = h.db.Conn.Exec(`UPDATE account_mfa SET secret='changed-fixture' WHERE user_id=?`, actor)
					case "password race":
						_, err = h.db.Conn.Exec(`UPDATE users SET password_hash='changed-fixture' WHERE id=?`, actor)
					case "revoked session":
						_, err = h.db.Conn.Exec(`UPDATE auth_sessions SET revoked_at=? WHERE id=?`, now, sid)
					}
					if err != nil {
						return nil, err
					}
					return repo.Transfer(ctx, actor, sid, hash, mfa, serverID, target, now)
				})
			}
			result, err := s.TransferServerOwnership(ctx, h.user.ID, login.SessionID, "handoff", target.ID, "current-password", codes[0])
			if scenario == "success" {
				if err != nil || result == nil || result.OwnerID != target.ID || events != 1 || inv.allCount != 1 {
					t.Fatal("transfer incomplete", result, err, events, inv.allCount)
				}
				if _, err = s.TransferServerOwnership(ctx, h.user.ID, login.SessionID, "handoff", target.ID, "current-password", codes[0]); err == nil {
					t.Fatal("recovery factor reused")
				}
				if events != 1 || inv.allCount != 1 {
					t.Fatal("replay changed runtime")
				}
			} else {
				if err == nil || result != nil || events != 0 || inv.allCount != 0 {
					t.Fatal("failed transfer changed runtime", result, err, events, inv.allCount)
				}
				var owner string
				if err := h.db.Conn.QueryRow(`SELECT owner_id FROM servers WHERE id='handoff'`).Scan(&owner); err != nil || owner != h.user.ID {
					t.Fatal("failed transfer changed owner", owner, err)
				}
			}
		})
	}
}
