package main

import (
	"fmt"
	"github.com/argeinfina/hichat/config"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

type voiceRuntimeFixtureProviders struct {
	services.AuditWriter
	services.VoiceAppLogger
}

func voiceRuntimeFixture(t *testing.T) voiceRuntimeDependencies {
	repos := startupPolicyRepositories(t)
	hub := ws.NewHub()
	permissions := services.NewChannelPermissionService(repos.ChannelPermission, repos.Role, repos.Channel, hub)
	t.Cleanup(permissions.Stop)
	providers := &voiceRuntimeFixtureProviders{}
	return voiceRuntimeDependencies{Repositories: repos, Hub: hub, Permissions: permissions, Audit: providers, Logger: providers, Config: &config.Config{}}
}
func voiceRuntimeCase(t *testing.T, base voiceRuntimeDependencies) voiceRuntimeDependencies {
	deps := base
	repos := *base.Repositories
	deps.Repositories = &repos
	cfg := *base.Config
	cfg.Upload.Dir = filepath.Join(t.TempDir(), "not-created")
	deps.Config = &cfg
	return deps
}
func expectVoiceRuntimePanic(t *testing.T, deps voiceRuntimeDependencies, want, path string) {
	t.Helper()
	before := routeCacheWorkerCount(t)
	var caught any
	func() {
		defer func() { caught = recover() }()
		group := initVoiceRuntimeServices(deps)
		group.Voice.ShutdownVoiceStateFanout()
		group.Music.StopAll()
	}()
	if fmt.Sprint(caught) != want {
		t.Errorf("panic=%v want %s", caught, want)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("invalid runtime touched upload directory: %v", err)
	}
	if after := routeCacheWorkerCount(t); after != before {
		t.Fatalf("invalid runtime leaked cache workers %d", after-before)
	}
}
func TestVoiceRuntimeRejectsMissingIntegration(t *testing.T) {
	base := voiceRuntimeFixture(t)
	for _, field := range []string{"Repositories", "Hub", "Permissions", "Audit", "Logger", "Config"} {
		t.Run(field, func(t *testing.T) {
			deps := voiceRuntimeCase(t, base)
			path := deps.Config.Upload.Dir
			v := reflect.ValueOf(&deps).Elem().FieldByName(field)
			v.Set(reflect.Zero(v.Type()))
			expectVoiceRuntimePanic(t, deps, "voice runtime requires "+field, path)
		})
	}
	for _, field := range []string{"Hub", "Permissions", "Audit", "Logger"} {
		t.Run("typed nil "+field, func(t *testing.T) {
			deps := voiceRuntimeCase(t, base)
			v := reflect.ValueOf(&deps).Elem().FieldByName(field)
			v.Set(reflect.Zero(v.Elem().Type()))
			expectVoiceRuntimePanic(t, deps, "voice runtime requires "+field, deps.Config.Upload.Dir)
		})
	}
}
func TestVoiceRuntimeRejectsMissingRepository(t *testing.T) {
	base := voiceRuntimeFixture(t)
	for _, field := range []string{"Channel", "LiveKit", "Server", "MemberTimeout", "Ban", "Entrance", "Role", "User", "MusicSession"} {
		for _, typedNil := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/typedNil=%v", field, typedNil), func(t *testing.T) {
				deps := voiceRuntimeCase(t, base)
				v := reflect.ValueOf(deps.Repositories).Elem().FieldByName(field)
				if typedNil {
					v.Set(reflect.Zero(v.Elem().Type()))
				} else {
					v.Set(reflect.Zero(v.Type()))
				}
				expectVoiceRuntimePanic(t, deps, "voice runtime requires repository "+field, deps.Config.Upload.Dir)
			})
		}
	}
}
func TestVoiceRuntimeValidCompositionRetainsOwners(t *testing.T) {
	deps := voiceRuntimeCase(t, voiceRuntimeFixture(t))
	group := initVoiceRuntimeServices(deps)
	if group.Voice == nil || group.Entrance == nil || group.Music == nil {
		t.Fatal("missing voice runtime owner")
	}
	t.Cleanup(group.Voice.ShutdownVoiceStateFanout)
	t.Cleanup(group.Music.StopAll)
}

type nilVoiceRuntimeAccess struct{ repository.VoiceAccessReader }

func TestVoiceRuntimeRejectsTypedNilOptionalAccess(t *testing.T) {
	deps := voiceRuntimeCase(t, voiceRuntimeFixture(t))
	var provider *nilVoiceRuntimeAccess
	deps.Repositories.VoiceAccess = provider
	expectVoiceRuntimePanic(t, deps, "voice runtime voice access provider is typed nil", deps.Config.Upload.Dir)
}
