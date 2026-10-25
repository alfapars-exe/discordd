package services

import (
	"context"
	"testing"

	"github.com/argeinfina/hichat/models"
)

func TestVoiceStateFanoutIgnoresStaleCachedPermissionGrant(t *testing.T) {
	fixture := permFixture{serverID: "server", channelID: "channel", roles: map[string][]models.Role{
		"viewer": {{ID: "role", ServerID: "server", Permissions: models.PermViewChannel}},
	}}
	resolver := fixture.newService(&bulkRepoCounter{})
	ctx := context.Background()
	users := []string{"viewer"}
	warm, err := resolver.ResolveChannelPermissionsBulk(ctx, "channel", users)
	if err != nil || !warm["viewer"].Has(models.PermViewChannel) {
		t.Fatalf("warm permissions=%v err=%v", warm, err)
	}
	// Simulate a committed role revocation in another instance: no local
	// InvalidateUser/InvalidateAll notification is available to this cache.
	fixture.roles["viewer"] = []models.Role{{ID: "role", ServerID: "server", Permissions: models.PermConnectVoice}}
	stale, err := resolver.ResolveChannelPermissionsBulk(ctx, "channel", users)
	if err != nil || !stale["viewer"].Has(models.PermViewChannel) {
		t.Fatal("fixture did not retain the cached grant")
	}
	fresh, err := resolveFreshVoiceFanoutPermissions(ctx, resolver, "channel", users)
	if err != nil || fresh["viewer"].Has(models.PermViewChannel) {
		t.Fatalf("voice fanout retained revoked grant: permissions=%v err=%v", fresh, err)
	}
}
