package main

import (
	"fmt"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

type expressionFixtureProviders struct {
	services.VoiceStateGetter
	services.EmojiService
}

func expressionFixture(t *testing.T) expressionAssetDependencies {
	providers := &expressionFixtureProviders{}
	return expressionAssetDependencies{Repositories: startupPolicyRepositories(t), Hub: ws.NewHub(), Voice: providers, Emoji: providers, UploadDir: filepath.Join(t.TempDir(), "not-created")}
}
func expectExpressionPanic(t *testing.T, deps expressionAssetDependencies, want string) {
	t.Helper()
	var caught any
	func() { defer func() { caught = recover() }(); initExpressionAssetServices(deps) }()
	if fmt.Sprint(caught) != want {
		t.Errorf("panic=%v want %s", caught, want)
	}
	if _, err := os.Stat(deps.UploadDir); !os.IsNotExist(err) {
		t.Errorf("invalid composition touched upload directory: %v", err)
	}
}
func TestExpressionAssetsRejectMissingIntegrationBeforeFilesystem(t *testing.T) {
	for _, field := range []string{"Repositories", "Hub", "Voice", "Emoji"} {
		t.Run(field, func(t *testing.T) {
			deps := expressionFixture(t)
			v := reflect.ValueOf(&deps).Elem().FieldByName(field)
			v.Set(reflect.Zero(v.Type()))
			expectExpressionPanic(t, deps, "expression assets requires "+field)
		})
	}
	for _, field := range []string{"Hub", "Voice", "Emoji"} {
		t.Run("typed nil "+field, func(t *testing.T) {
			deps := expressionFixture(t)
			v := reflect.ValueOf(&deps).Elem().FieldByName(field)
			v.Set(reflect.Zero(v.Elem().Type()))
			expectExpressionPanic(t, deps, "expression assets requires "+field)
		})
	}
}
func TestExpressionAssetsRejectMissingRepositoryBeforeFilesystem(t *testing.T) {
	for _, field := range []string{"Soundboard", "User", "Sticker", "Emoji", "Server", "Cosmetic"} {
		for _, typedNil := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/typedNil=%v", field, typedNil), func(t *testing.T) {
				deps := expressionFixture(t)
				v := reflect.ValueOf(deps.Repositories).Elem().FieldByName(field)
				if typedNil {
					v.Set(reflect.Zero(v.Elem().Type()))
				} else {
					v.Set(reflect.Zero(v.Type()))
				}
				expectExpressionPanic(t, deps, "expression assets requires repository "+field)
			})
		}
	}
}
func TestExpressionAssetsValidCompositionRetainsOwners(t *testing.T) {
	deps := expressionFixture(t)
	group := initExpressionAssetServices(deps)
	for _, field := range []string{"Soundboard", "Sticker", "Clone", "Cosmetic"} {
		if reflect.ValueOf(group).FieldByName(field).IsNil() {
			t.Fatalf("missing owner %s", field)
		}
	}
	if _, err := os.Stat(deps.UploadDir); err != nil {
		t.Fatalf("valid upload setup: %v", err)
	}
}
