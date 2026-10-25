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

type applicationRuntimeRecorder struct {
	events  []ws.Event
	added   [][2]string
	removed [][2]string
}

func (*applicationRuntimeRecorder) DisconnectUser(string) {}
func (r *applicationRuntimeRecorder) BroadcastToUser(_ string, event ws.Event) {
	r.events = append(r.events, event)
}
func (r *applicationRuntimeRecorder) AddClientServerID(userID, serverID string) {
	r.added = append(r.added, [2]string{userID, serverID})
}
func (r *applicationRuntimeRecorder) RemoveClientServerID(userID, serverID string) {
	r.removed = append(r.removed, [2]string{userID, serverID})
}

type applicationPermissionStub struct{ permissions models.Permission }

func (s applicationPermissionStub) ResolveChannelPermissions(context.Context, string, string) (models.Permission, error) {
	return s.permissions, nil
}

func TestApplicationRegistryScopesInvocationAndRevocation(t *testing.T) {
	db := newBotTestDB(t)
	ctx := context.Background()
	if _, err := db.Conn.ExecContext(ctx, `
		INSERT INTO users(id,username,password_hash) VALUES('owner','owner','x'),('actor','actor','x');
		INSERT INTO servers(id,name,owner_id) VALUES('server','Server','owner');
		INSERT INTO server_members(server_id,user_id) VALUES('server','owner'),('server','actor');
		INSERT INTO channels(id,name,type,server_id) VALUES('channel','general','text','server');
		INSERT INTO messages(id,channel_id,user_id,content) VALUES('message','channel','actor','secret text');`); err != nil {
		t.Fatal(err)
	}
	runtime := &applicationRuntimeRecorder{}
	svc := NewBotService(repository.NewBotRepository(db.Conn), runtime)
	svc.SetApplicationPermissionResolver(applicationPermissionStub{permissions: models.PermViewChannel | models.PermReadMessages})
	bot, _, err := svc.CreateBot(ctx, "owner", models.CreateBotRequest{Username: "actionbot", DisplayName: "Action Bot"})
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := svc.PutApplicationManifest(ctx, "owner", bot.ID, "message actions", true, []models.ApplicationAction{{Name: "summarize", Label: "Summarize"}})
	if err != nil || len(manifest.Actions) != 1 {
		t.Fatalf("manifest=%+v err=%v", manifest, err)
	}
	if _, err := svc.InstallApplication(ctx, "owner", "server", bot.ID, []string{models.ApplicationScopeSendResponse}); err != nil {
		t.Fatal(err)
	}
	if len(runtime.added) != 1 {
		t.Fatalf("runtime additions=%v", runtime.added)
	}
	invocation, err := svc.InvokeApplicationAction(ctx, "actor", "server", "channel", "message", manifest.Actions[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(runtime.events) != 1 || runtime.events[0].Op != ws.OpApplicationInvocation {
		t.Fatalf("events=%+v", runtime.events)
	}
	contextPayload, ok := runtime.events[0].Data.(*models.ApplicationInvocationContext)
	if !ok || contextPayload.MessageContent != nil {
		t.Fatalf("message content leaked without scope: %#v", runtime.events[0].Data)
	}
	result := "done"
	if err := svc.CompleteApplicationInvocation(ctx, bot.ID, invocation.ID, "succeeded", &result, nil); err != nil {
		t.Fatal(err)
	}
	if err := svc.RevokeApplicationInstallation(ctx, "server", bot.ID); err != nil {
		t.Fatal(err)
	}
	if len(runtime.removed) != 1 {
		t.Fatalf("runtime removals=%v", runtime.removed)
	}
	if _, err := svc.InvokeApplicationAction(ctx, "actor", "server", "channel", "message", manifest.Actions[0].ID); err == nil {
		t.Fatal("revoked application still invoked")
	}
}

func TestApplicationRegistryReadScopeAndCompletionIsolation(t *testing.T) {
	db := newBotTestDB(t)
	ctx := context.Background()
	if _, err := db.Conn.ExecContext(ctx, `
		INSERT INTO users(id,username,password_hash) VALUES('owner','owner','x'),('other','other','x'),('actor','actor','x');
		INSERT INTO servers(id,name,owner_id) VALUES('server','Server','owner');
		INSERT INTO server_members(server_id,user_id) VALUES('server','owner'),('server','actor');
		INSERT INTO channels(id,name,type,server_id) VALUES('channel','general','text','server');
		INSERT INTO messages(id,channel_id,user_id,content) VALUES('message','channel','actor','readable');`); err != nil {
		t.Fatal(err)
	}
	runtime := &applicationRuntimeRecorder{}
	svc := NewBotService(repository.NewBotRepository(db.Conn), runtime)
	svc.SetApplicationPermissionResolver(applicationPermissionStub{permissions: models.PermViewChannel | models.PermReadMessages})
	bot, _, _ := svc.CreateBot(ctx, "owner", models.CreateBotRequest{Username: "readerbot", DisplayName: "Reader"})
	otherBot, _, _ := svc.CreateBot(ctx, "other", models.CreateBotRequest{Username: "otherbot", DisplayName: "Other"})
	manifest, err := svc.PutApplicationManifest(ctx, "owner", bot.ID, "", true, []models.ApplicationAction{{Name: "inspect", Label: "Inspect"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.PutApplicationManifest(ctx, "other", bot.ID, "", false, nil); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("foreign manifest error=%v", err)
	}
	if _, err := svc.InstallApplication(ctx, "owner", "server", bot.ID, []string{"unknown"}); !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("unknown scope error=%v", err)
	}
	if _, err := svc.InstallApplication(ctx, "owner", "server", bot.ID, []string{models.ApplicationScopeReadMessage}); err != nil {
		t.Fatal(err)
	}
	invocation, err := svc.InvokeApplicationAction(ctx, "actor", "server", "channel", "message", manifest.Actions[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	payload := runtime.events[len(runtime.events)-1].Data.(*models.ApplicationInvocationContext)
	if payload.MessageContent == nil || *payload.MessageContent != "readable" {
		t.Fatalf("payload=%+v", payload)
	}
	result := "not authorized"
	if err := svc.CompleteApplicationInvocation(ctx, bot.ID, invocation.ID, "succeeded", &result, nil); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("response without scope error=%v", err)
	}
	if err := svc.CompleteApplicationInvocation(ctx, otherBot.ID, invocation.ID, "failed", nil, nil); !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("foreign bot completion error=%v", err)
	}
}
