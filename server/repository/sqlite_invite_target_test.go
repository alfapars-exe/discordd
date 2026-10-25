package repository

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func TestInviteTargetMustBelongToInviteServer(t *testing.T) {
	db := newTestDB(t)
	execSeed(t, db, []seedStmt{
		{q: `INSERT INTO users(id,username,password_hash) VALUES('invite-owner','invite-owner','x')`},
		{q: `INSERT INTO servers(id,name,owner_id) VALUES('invite-a','A','invite-owner'),('invite-b','B','invite-owner')`},
		{q: `INSERT INTO channels(id,name,type,server_id) VALUES('channel-a','general','text','invite-a'),('channel-b','private','text','invite-b')`},
	})
	repo := NewSQLiteInviteRepo(wrapForRepo(db))
	target := "channel-a"
	valid := &models.Invite{Code: "valid-target", ServerID: "invite-a", CreatedBy: "invite-owner", ChannelID: &target}
	if err := repo.Create(context.Background(), valid); err != nil {
		t.Fatalf("create targeted invite: %v", err)
	}
	got, err := repo.GetByCode(context.Background(), valid.Code)
	if err != nil || got.ChannelID == nil || *got.ChannelID != target {
		t.Fatalf("target did not persist: invite=%#v err=%v", got, err)
	}

	foreign := "channel-b"
	err = repo.Create(context.Background(), &models.Invite{Code: "foreign-target", ServerID: "invite-a", CreatedBy: "invite-owner", ChannelID: &foreign})
	if !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("expected bad request for cross-server target, got %v", err)
	}
}
