package main

import (
	"context"
	"fmt"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

type voiceMediaFixtureProviders struct {
	services.ChannelPermResolver
	services.MusicAudienceFreshPermissions
	services.VoiceAppLogger
}

func voiceMediaFixture(t *testing.T) voiceMediaDependencies {
	providers := &voiceMediaFixtureProviders{}
	return voiceMediaDependencies{Repositories: startupPolicyRepositories(t), Hub: ws.NewHub(), Permissions: providers, FreshPermissions: providers, Voice: &voiceRoutingRecorder{}, Logger: providers, UploadDir: filepath.Join(t.TempDir(), "not-created")}
}
func assertVoiceMediaRejected(t *testing.T, deps voiceMediaDependencies, want string) {
	t.Helper()
	var reads int
	if !missingCompositionInput(deps.Repositories) && !missingCompositionInput(deps.Repositories.MusicSession) {
		repos := *deps.Repositories
		deps.Repositories = &repos
		deps.Repositories.MusicSession = &voiceMediaSessionReads{MusicSessionStore: repos.MusicSession, reads: &reads}
	}
	var caught any
	func() { defer func() { caught = recover() }(); initVoiceMediaServices(deps) }()
	if fmt.Sprint(caught) != want {
		t.Errorf("panic=%v want %s", caught, want)
	}
	if reads != 0 {
		t.Errorf("invalid composition read sessions %d times", reads)
	}
	if _, err := os.Stat(deps.UploadDir); !os.IsNotExist(err) {
		t.Errorf("invalid composition touched upload directory: %v", err)
	}
}
func TestVoiceMediaRejectsMissingIntegrationBeforeSideEffects(t *testing.T) {
	base := voiceMediaFixture(t)
	for _, field := range []string{"Repositories", "Hub", "Permissions", "FreshPermissions", "Voice", "Logger"} {
		for _, typedNil := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/typedNil=%v", field, typedNil), func(t *testing.T) {
				deps := base
				v := reflect.ValueOf(&deps).Elem().FieldByName(field)
				if typedNil && v.Kind() == reflect.Interface {
					v.Set(reflect.Zero(v.Elem().Type()))
				} else {
					v.Set(reflect.Zero(v.Type()))
				}
				assertVoiceMediaRejected(t, deps, "voice media requires "+field)
			})
		}
	}
}
func TestVoiceMediaRejectsMissingRepositoryBeforeSideEffects(t *testing.T) {
	base := voiceMediaFixture(t)
	for _, field := range []string{"Entrance", "Server", "Role", "Channel", "LiveKit", "User", "MusicSession"} {
		for _, typedNil := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/typedNil=%v", field, typedNil), func(t *testing.T) {
				deps := base
				repos := *base.Repositories
				deps.Repositories = &repos
				v := reflect.ValueOf(&repos).Elem().FieldByName(field)
				if typedNil {
					v.Set(reflect.Zero(v.Elem().Type()))
				} else {
					v.Set(reflect.Zero(v.Type()))
				}
				assertVoiceMediaRejected(t, deps, "voice media requires repository "+field)
			})
		}
	}
}

type voiceMediaSessionReads struct {
	repository.MusicSessionStore
	reads *int
}

func (s *voiceMediaSessionReads) List(ctx context.Context) ([]models.MusicSession, error) {
	*s.reads++
	return s.MusicSessionStore.List(ctx)
}
func TestVoiceMediaValidCompositionRetainsOwnersAndLoadsOnce(t *testing.T) {
	deps := voiceMediaFixture(t)
	var reads int
	deps.Repositories.MusicSession = &voiceMediaSessionReads{MusicSessionStore: deps.Repositories.MusicSession, reads: &reads}
	entrance, music := initVoiceMediaServices(deps)
	if entrance == nil || music == nil {
		t.Fatal("missing media owner")
	}
	t.Cleanup(music.StopAll)
	if reads != 1 {
		t.Fatalf("session reads=%d want 1", reads)
	}
	if _, err := os.Stat(deps.UploadDir); err != nil {
		t.Fatalf("valid upload setup: %v", err)
	}
}
