package services

import (
	"context"
	"errors"
	"github.com/argeinfina/hichat/models"
	"testing"
)

type voicePermissionChoice struct {
	ChannelPermResolver
	cachedCalls, freshCalls         int
	cachedBulkCalls, freshBulkCalls int
	err                             error
}

func (r *voicePermissionChoice) ResolveChannelPermissions(context.Context, string, string) (models.Permission, error) {
	r.cachedCalls++
	return models.PermConnectVoice, nil
}
func (r *voicePermissionChoice) ResolveChannelPermissionsFresh(context.Context, string, string) (models.Permission, error) {
	r.freshCalls++
	return 0, r.err
}
func TestVoiceFreshPermissionDependencyIsExplicitAndErrorsNeverFallBack(t *testing.T) {
	for _, tc := range []struct {
		name          string
		enabled, fail bool
	}{
		{name: "fresh denial", enabled: true}, {name: "fresh error", enabled: true, fail: true}, {name: "standalone cached choice"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cached, fresh := &voicePermissionChoice{}, &voicePermissionChoice{}
			runtime := VoiceRuntimeDependencies{}
			if tc.enabled {
				runtime.FreshPermissions = fresh
			}
			if tc.fail {
				fresh.err = errors.New("fresh permission unavailable")
			}
			service := NewVoiceService(nil, nil, cached, nil, nil, nil, nil, nil, nil, nil, runtime).(*voiceService)
			t.Cleanup(service.ShutdownVoiceStateFanout)
			permission, err := service.currentVoicePermissions(context.Background(), "user", "channel")
			if tc.enabled {
				if permission != 0 || !errors.Is(err, fresh.err) || fresh.freshCalls != 1 || cached.cachedCalls != 0 || cached.freshCalls != 0 {
					t.Fatalf("fresh result=%d err=%v calls cached=%d fresh=%d", permission, err, cached.cachedCalls, fresh.freshCalls)
				}
			} else {
				if err != nil || permission != models.PermConnectVoice || cached.cachedCalls != 1 || cached.freshCalls != 0 || fresh.freshCalls != 0 {
					t.Fatal("standalone mode rediscovered an undeclared fresh resolver")
				}
			}
		})
	}
}

func (r *voicePermissionChoice) ResolveChannelPermissionsBulkFresh(context.Context, string, []string) (map[string]models.Permission, error) {
	r.freshBulkCalls++
	return map[string]models.Permission{"user": 0}, r.err
}

func (r *voicePermissionChoice) ResolveChannelPermissionsBulk(context.Context, string, []string) (map[string]models.Permission, error) {
	r.cachedBulkCalls++
	return map[string]models.Permission{"user": models.PermViewChannel}, nil
}
func TestVoiceFreshBulkPermissionDependencyNeverFallsBackOnDenialOrError(t *testing.T) {
	for _, tc := range []struct {
		name          string
		enabled, fail bool
	}{{name: "fresh denial", enabled: true}, {name: "fresh error", enabled: true, fail: true}, {name: "standalone bulk"}} {
		t.Run(tc.name, func(t *testing.T) {
			ordinary, fresh := &voicePermissionChoice{}, &voicePermissionChoice{}
			runtime := VoiceRuntimeDependencies{}
			if tc.enabled {
				runtime.FreshPermissions = fresh
			}
			if tc.fail {
				fresh.err = errors.New("bulk freshness unavailable")
			}
			service := NewVoiceService(nil, nil, ordinary, nil, nil, nil, nil, nil, nil, nil, runtime).(*voiceService)
			t.Cleanup(service.ShutdownVoiceStateFanout)
			permissions, err := service.currentVoiceBulkPermissions(context.Background(), "channel", []string{"user"})
			if tc.enabled {
				if !errors.Is(err, fresh.err) || permissions["user"] != 0 || fresh.freshBulkCalls != 1 || ordinary.cachedBulkCalls != 0 || ordinary.freshBulkCalls != 0 {
					t.Fatal("fresh bulk result fell back or used undeclared provider")
				}
			} else {
				if err != nil || permissions["user"] != models.PermViewChannel || ordinary.cachedBulkCalls != 1 || ordinary.freshBulkCalls != 0 {
					t.Fatal("standalone bulk mode rediscovered freshness")
				}
			}
		})
	}
}
