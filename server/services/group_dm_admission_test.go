package services

import (
	"context"
	"errors"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
	"testing"
)

type admissionMutationRepo struct {
	repository.GroupDMRepository
	before func()
	actor  []string
}

func (r *admissionMutationRepo) Create(ctx context.Context, g *models.GroupDM, ids []string, actor ...string) error {
	r.actor = actor
	if r.before != nil {
		r.before()
	}
	return r.GroupDMRepository.Create(ctx, g, ids, actor...)
}
func (r *admissionMutationRepo) AddMember(ctx context.Context, g, u string, actor ...string) (int64, error) {
	r.actor = actor
	if r.before != nil {
		r.before()
	}
	return r.GroupDMRepository.AddMember(ctx, g, u, actor...)
}
func TestGroupAdmissionServiceRejectsKnownIDWithoutAcceptedFriendship(t *testing.T) {
	for _, action := range []string{"create", "add"} {
		for _, status := range []string{"missing", "pending", "rejected", "nil", "error", "block error", "blocked"} {
			t.Run(action+"/"+status, func(t *testing.T) {
				db := newBotTestDB(t)
				ctx := context.Background()
				for _, id := range []string{"owner", "target"} {
					if _, err := db.Conn.Exec(`INSERT INTO users(id,username,password_hash) VALUES(?,?,'x')`, id, id); err != nil {
						t.Fatal(err)
					}
				}
				groups := repository.NewSQLiteGroupDMRepo(db.Conn)
				if action == "add" {
					if err := groups.Create(ctx, &models.GroupDM{ID: "group", OwnerID: "owner", Name: "Group", KeyEpoch: 1, CallRoomKey: "room"}, []string{"owner"}); err != nil {
						t.Fatal(err)
					}
				}
				events := 0
				hub := &testutil.MockBroadcaster{BroadcastToUsersFn: func([]string, ws.Event) { events++ }, BroadcastToUserFn: func(string, ws.Event) { events++ }}
				friends := &testutil.MockFriendshipRepo{IsBlockedFn: func(context.Context, string, string) (bool, error) {
					if status == "block error" {
						return false, errors.New("block lookup unavailable")
					}
					return status == "blocked", nil
				}, GetByPairFn: func(context.Context, string, string) (*models.Friendship, error) {
					if status == "missing" {
						return nil, pkg.ErrNotFound
					}
					if status == "error" {
						return nil, errors.New("lookup unavailable")
					}
					if status == "nil" {
						return nil, nil
					}
					return &models.Friendship{UserID: "owner", FriendID: "target", Status: models.FriendshipStatus(status)}, nil
				}}
				svc := NewGroupDMService(groups, repository.NewSQLiteUserRepo(db.Conn), friends, hub, "", "", "", nil, "")
				var err error
				if action == "create" {
					_, err = svc.Create(ctx, "owner", &models.CreateGroupDMRequest{Name: "Group", UserIDs: []string{"target"}})
				} else {
					_, err = svc.AddMember(ctx, "group", "owner", "target")
				}
				if err == nil {
					t.Fatal("known ID admitted without accepted friendship")
				}
				var count, notices int
				if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM group_dm_members WHERE user_id='target'`).Scan(&count); err != nil {
					t.Fatal(err)
				}
				if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM notifications`).Scan(&notices); err != nil {
					t.Fatal(err)
				}
				if count != 0 || notices != 0 || events != 0 {
					t.Fatalf("denied admission mutated member=%d notices=%d events=%d", count, notices, events)
				}
				if action == "add" {
					g, err := groups.GetByID(ctx, "group")
					if err != nil || g.KeyEpoch != 1 {
						t.Fatalf("key epoch changed %+v %v", g, err)
					}
					if token, err := svc.GenerateCallToken(ctx, "group", "target"); token != nil || !errors.Is(err, pkg.ErrNotFound) {
						t.Fatalf("target obtained call/key material token=%v err=%v", token, err)
					}
				}
			})
		}
	}
}
func TestGroupAdmissionServicePassesAuthenticatedScopeAndRechecksUnfriendBeforeWrite(t *testing.T) {
	for _, action := range []string{"create", "add"} {
		for _, unfriend := range []bool{false, true} {
			t.Run(action+map[bool]string{false: "/accepted", true: "/unfriend-before-write"}[unfriend], func(t *testing.T) {
				db := newBotTestDB(t)
				ctx := context.Background()
				for _, id := range []string{"owner", "target"} {
					if _, err := db.Conn.Exec(`INSERT INTO users(id,username,password_hash,dm_privacy) VALUES(?,?,'x','friends_only')`, id, id); err != nil {
						t.Fatal(err)
					}
				}
				if _, err := db.Conn.Exec(`INSERT INTO friendships(id,user_id,friend_id,status) VALUES('pair','target','owner','accepted')`); err != nil {
					t.Fatal(err)
				}
				base := repository.NewSQLiteGroupDMRepo(db.Conn)
				if action == "add" {
					if err := base.Create(ctx, &models.GroupDM{ID: "group", OwnerID: "owner", Name: "Group", KeyEpoch: 1, CallRoomKey: "room"}, []string{"owner"}); err != nil {
						t.Fatal(err)
					}
				}
				scoped := &admissionMutationRepo{GroupDMRepository: base}
				if unfriend {
					scoped.before = func() {
						if _, err := db.Conn.Exec(`DELETE FROM friendships WHERE id='pair'`); err != nil {
							t.Fatal(err)
						}
					}
				}
				events := 0
				hub := &testutil.MockBroadcaster{BroadcastToUsersFn: func([]string, ws.Event) { events++ }, BroadcastToUserFn: func(string, ws.Event) { events++ }}
				svc := NewGroupDMService(scoped, repository.NewSQLiteUserRepo(db.Conn), repository.NewSQLiteFriendshipRepo(db.Conn), hub, "", "", "", nil, "")
				var result *models.GroupDM
				var err error
				if action == "create" {
					result, err = svc.Create(ctx, "owner", &models.CreateGroupDMRequest{Name: "Group", UserIDs: []string{"target"}})
				} else {
					result, err = svc.AddMember(ctx, "group", "owner", "target")
				}
				if len(scoped.actor) != 1 || scoped.actor[0] != "owner" {
					t.Fatalf("missing authenticated scope %+v", scoped.actor)
				}
				if unfriend {
					if !errors.Is(err, pkg.ErrForbidden) || result != nil || events != 0 {
						t.Fatalf("stale friendship admitted result=%v err=%v events=%d", result, err, events)
					}
					var count int
					if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM group_dm_members WHERE user_id='target'`).Scan(&count); err != nil || count != 0 {
						t.Fatalf("partial target membership=%d err=%v", count, err)
					}
				} else if err != nil || result == nil || len(result.Members) != 2 || events == 0 {
					t.Fatalf("accepted friend rejected result=%v err=%v events=%d", result, err, events)
				}
			})
		}
	}
}
