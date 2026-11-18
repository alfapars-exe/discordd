package services

import (
	"context"
	"errors"
	"github.com/argeinfina/hichat/models"
	"testing"
)

func TestGameJoinDeclaredFreshProviderRejectsCachedConnectGrant(t *testing.T) {
	fixture := permFixture{serverID: "server", channelID: "channel", roles: map[string][]models.Role{"viewer": {{ID: "role", ServerID: "server", Permissions: models.PermViewChannel | models.PermConnectVoice}}}}
	resolver := fixture.newService(t, &bulkRepoCounter{})
	ctx := context.Background()
	users := []string{"viewer"}
	if granted, err := resolver.ResolveChannelPermissionsBulk(ctx, "channel", users); err != nil || !granted["viewer"].Has(models.PermConnectVoice) {
		t.Fatal("warm grant missing")
	}
	fixture.roles["viewer"] = []models.Role{{ID: "role", ServerID: "server", Permissions: models.PermViewChannel}}
	fresh := NewGameJoinPolicy(nil, nil, nil, nil, nil, nil, nil, nil, resolver, nil, resolver).(*gameJoinPolicy)
	current, err := fresh.resolveVoicePermissions(ctx, "channel", users)
	if err != nil || current["viewer"].Has(models.PermConnectVoice) {
		t.Fatal("declared fresh provider retained revoked connect grant")
	}
	standalone := NewGameJoinPolicy(nil, nil, nil, nil, nil, nil, nil, nil, resolver, nil, nil).(*gameJoinPolicy)
	cached, err := standalone.resolveVoicePermissions(ctx, "channel", users)
	if err != nil || !cached["viewer"].Has(models.PermConnectVoice) {
		t.Fatal("standalone choice rediscovered fresh capability")
	}
	failure := errors.New("fresh permission unavailable")
	selected := &voicePermissionChoice{err: failure}
	failing := NewGameJoinPolicy(nil, nil, nil, nil, nil, nil, nil, nil, resolver, nil, selected).(*gameJoinPolicy)
	if _, err := failing.resolveVoicePermissions(ctx, "channel", users); !errors.Is(err, failure) {
		t.Fatal("fresh provider error fell back to cached grant")
	}
}
