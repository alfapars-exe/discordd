package main

import (
	"context"
	"testing"

	"github.com/argeinfina/hichat/config"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

func TestFriendshipDMProductionWiringAutoAcceptsAndReadsCommittedFriendship(t *testing.T) {
	for _, mutual := range []bool{false, true} {
		name := "explicit accept"
		if mutual {
			name = "mutual requests"
		}
		t.Run(name, func(t *testing.T) {
			db, _ := newCensusDB(t)
			uploads := t.TempDir()
			repos := initRepositories(db.Conn, repository.DataExportStorageOptions{UploadDir: uploads, ArchiveDir: t.TempDir()})
			cfg := &config.Config{}
			cfg.Upload.Dir = uploads
			bundle, limiters, metrics := initServices(db.Conn, repos, ws.NewHub(), cfg, nil, nil)
			t.Cleanup(func() {
				limiters.Stop()
				metrics.Stop()
				stopServiceCacheWorkers(bundle)
				bundle.Voice.ShutdownVoiceStateFanout()
				bundle.OnlineFriendNotifier.Stop()
				bundle.LinkPreview.Stop()
			})
			ctx := context.Background()
			alice := &models.User{Username: "wire_alice", PasswordHash: "fixture", Status: "online"}
			bob := &models.User{Username: "wire_bob", PasswordHash: "fixture", Status: "online"}
			for _, user := range []*models.User{alice, bob} {
				if err := repos.User.Create(ctx, user); err != nil {
					t.Fatal(err)
				}
			}
			first, second := alice.ID, bob.ID
			if first > second {
				first, second = second, first
			}
			channel := &models.DMChannel{User1ID: first, User2ID: second, Status: models.DMStatusPending, InitiatedBy: &alice.ID}
			if err := repos.DM.CreateChannel(ctx, channel); err != nil {
				t.Fatal(err)
			}
			request, err := bundle.Friendship.SendRequest(ctx, alice.ID, &models.SendFriendRequestRequest{Username: bob.Username})
			if err != nil {
				t.Fatal(err)
			}
			before, err := repos.DM.GetChannelByID(ctx, channel.ID)
			if err != nil || before.Status != models.DMStatusPending {
				t.Fatalf("pending precondition: %#v %v", before, err)
			}
			if mutual {
				_, err = bundle.Friendship.SendRequest(ctx, bob.ID, &models.SendFriendRequestRequest{Username: alice.Username})
			} else {
				_, err = bundle.Friendship.AcceptRequest(ctx, bob.ID, request.ID)
			}
			if err != nil {
				t.Fatal(err)
			}
			accepted, err := repos.DM.GetChannelByID(ctx, channel.ID)
			if err != nil || accepted.Status != models.DMStatusAccepted {
				t.Fatalf("auto-accept wiring: %#v %v", accepted, err)
			}
			message, err := bundle.DM.SendMessage(ctx, alice.ID, channel.ID, &models.CreateDMMessageRequest{Content: "committed friends"})
			if err != nil || message == nil {
				t.Fatalf("friend message: %#v %v", message, err)
			}
			persisted, err := repos.DM.GetMessageByID(ctx, message.ID)
			if err != nil || persisted == nil || persisted.Content == nil || *persisted.Content != "committed friends" || persisted.UserID != alice.ID {
				t.Fatalf("committed friend message: %#v %v", persisted, err)
			}
			after, err := repos.DM.GetChannelByID(ctx, channel.ID)
			if err != nil || after.Status != models.DMStatusAccepted {
				t.Fatalf("DM graph reader ignored committed friendship: %#v %v", after, err)
			}
		})
	}
}
