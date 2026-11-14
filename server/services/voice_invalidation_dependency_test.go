package services

import (
	"context"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/testutil"
	"reflect"
	"testing"
)

type voiceInvalidationFixture struct {
	callback func(string, string)
	bindings int
}

func (s *voiceInvalidationFixture) BindInvalidationCallback(cb func(string, string)) {
	s.bindings++
	s.callback = cb
}
func TestVoiceInvalidationConstructorBindsScopedActiveRecheck(t *testing.T) {
	source := &voiceInvalidationFixture{}
	scopes := [][]string{}
	permissions := &testutil.MockChannelPermResolver{ResolveChannelPermissionsBulkFn: func(ctx context.Context, channel string, users []string) (map[string]models.Permission, error) {
		if _, ok := ctx.Deadline(); !ok {
			t.Fatal("active recheck lost its budget")
		}
		if len(users) != 1 {
			t.Fatal("scope included an unrelated voice user")
		}
		scopes = append(scopes, []string{channel, users[0]})
		return map[string]models.Permission{users[0]: models.PermConnectVoice}, nil
	}}
	service := NewVoiceService(nil, nil, permissions, nil, nil, nil, nil, nil, nil, nil, VoiceRuntimeDependencies{PermissionInvalidations: source}).(*voiceService)
	t.Cleanup(service.ShutdownVoiceStateFanout)
	if source.bindings != 1 || source.callback == nil {
		t.Fatal("constructor omitted invalidation subscription")
	}
	service.states["first"] = &models.VoiceState{UserID: "first", ChannelID: "one"}
	service.states["second"] = &models.VoiceState{UserID: "second", ChannelID: "two"}
	source.callback("", "one")
	source.callback("second", "")
	if !reflect.DeepEqual(scopes, [][]string{{"one", "first"}, {"two", "second"}}) {
		t.Fatalf("recheck scope=%v", scopes)
	}
}
func TestPermissionFactoryInvalidationsPublishDeclaredScopes(t *testing.T) {
	permissions := NewChannelPermissionService(nil, nil, nil, nil)
	t.Cleanup(permissions.Stop)
	scopes := [][]string{}
	permissions.BindInvalidationCallback(func(user, channel string) { scopes = append(scopes, []string{user, channel}) })
	permissions.InvalidateUser("user")
	permissions.(*cachingPermResolver).invalidateChannelCache("channel")
	permissions.InvalidateAll()
	if !reflect.DeepEqual(scopes, [][]string{{"user", ""}, {"", "channel"}, {"", ""}}) {
		t.Fatalf("invalidation scopes=%v", scopes)
	}
}
