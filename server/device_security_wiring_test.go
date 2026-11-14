package main

import (
	"context"
	"errors"
	"fmt"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/crypto"
	"github.com/argeinfina/hichat/ws"
	"reflect"
	"testing"
)

func deviceSecurityFixture(t *testing.T) deviceSecurityDependencies {
	db, repos := startupServiceDependencies(t)
	return deviceSecurityDependencies{Database: db, Repositories: repos, Hub: ws.NewHub(), Permissions: &voiceMediaFixtureProviders{}}
}
func expectDeviceSecurityPanic(t *testing.T, deps deviceSecurityDependencies, want string) {
	t.Helper()
	var caught any
	func() { defer func() { caught = recover() }(); initDeviceSecurityServices(deps) }()
	if fmt.Sprint(caught) != want {
		t.Fatalf("panic=%v want %s", caught, want)
	}
}
func TestDeviceSecurityRejectsMissingIntegration(t *testing.T) {
	base := deviceSecurityFixture(t)
	for _, field := range []string{"Database", "Repositories", "Hub", "Permissions"} {
		t.Run(field, func(t *testing.T) {
			deps := base
			v := reflect.ValueOf(&deps).Elem().FieldByName(field)
			v.Set(reflect.Zero(v.Type()))
			expectDeviceSecurityPanic(t, deps, "device security requires "+field)
		})
	}
	for _, field := range []string{"Hub", "Permissions"} {
		t.Run("typed nil "+field, func(t *testing.T) {
			deps := base
			v := reflect.ValueOf(&deps).Elem().FieldByName(field)
			v.Set(reflect.Zero(v.Elem().Type()))
			expectDeviceSecurityPanic(t, deps, "device security requires "+field)
		})
	}
}
func TestDeviceSecurityRejectsMissingRepository(t *testing.T) {
	base := deviceSecurityFixture(t)
	for _, field := range []string{"Device", "Server", "E2EEBackup", "GroupSession", "Channel"} {
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
				expectDeviceSecurityPanic(t, deps, "device security requires repository "+field)
			})
		}
	}
}
func TestDeviceSecurityValidCompositionRetainsOwners(t *testing.T) {
	group := initDeviceSecurityServices(deviceSecurityFixture(t))
	if group.Device == nil || group.E2EE == nil {
		t.Fatal("missing device security owner")
	}
}

func TestDeviceSecurityCompositionBackupIntegrityUsesMasterKey(t *testing.T) {
	deps := deviceSecurityFixture(t)
	deps.EncryptionKey = []byte("composition-master-key-0123456789")
	group := initDeviceSecurityServices(deps)
	ctx := context.Background()
	user := &models.User{Username: "backup_wiring", PasswordHash: "fixture", Status: "offline"}
	if err := deps.Repositories.User.Create(ctx, user); err != nil {
		t.Fatal(err)
	}
	req := &models.CreateKeyBackupRequest{Version: 1, Algorithm: "aes-256-gcm", EncryptedData: "opaque-cipher", Nonce: "nonce", Salt: "salt"}
	if err := group.E2EE.UpsertKeyBackup(ctx, user.ID, req); err != nil {
		t.Fatal(err)
	}
	stored, err := deps.Repositories.E2EEBackup.GetByUser(ctx, user.ID)
	if err != nil || stored == nil || stored.BackupHMAC == "" {
		t.Fatalf("stored backup=%+v err=%v", stored, err)
	}
	if !crypto.VerifyBackupHMAC(crypto.DeriveBackupHMACKey(deps.EncryptionKey), stored.BackupHMAC, user.ID, stored.Version, stored.Algorithm, stored.EncryptedData, stored.Nonce, stored.Salt) {
		t.Fatal("persisted MAC does not use the backup HKDF subkey")
	}
	got, err := group.E2EE.GetKeyBackup(ctx, user.ID)
	if err != nil || got == nil || got.EncryptedData != req.EncryptedData {
		t.Fatalf("round trip=%+v err=%v", got, err)
	}
	wrong := deps
	wrong.EncryptionKey = []byte("different-composition-master-key")
	if _, err := initDeviceSecurityServices(wrong).E2EE.GetKeyBackup(ctx, user.ID); !errors.Is(err, pkg.ErrInternal) {
		t.Fatalf("wrong master key accepted: %v", err)
	}
	originalMAC := stored.BackupHMAC
	req.EncryptedData = "changed-opaque-cipher"
	if err := deps.Repositories.E2EEBackup.Upsert(ctx, user.ID, req, originalMAC); err != nil {
		t.Fatal(err)
	}
	if _, err := group.E2EE.GetKeyBackup(ctx, user.ID); !errors.Is(err, pkg.ErrInternal) {
		t.Fatalf("modified persisted cipher accepted: %v", err)
	}
	if err := group.E2EE.UpsertKeyBackup(ctx, user.ID, req); err != nil {
		t.Fatal(err)
	}
	got, err = group.E2EE.GetKeyBackup(ctx, user.ID)
	if err != nil || got == nil || got.EncryptedData != req.EncryptedData {
		t.Fatalf("updated round trip=%+v err=%v", got, err)
	}
	if err := group.E2EE.DeleteKeyBackup(ctx, user.ID); err != nil {
		t.Fatal(err)
	}
	got, err = group.E2EE.GetKeyBackup(ctx, user.ID)
	if err != nil || got != nil {
		t.Fatalf("deleted backup=%+v err=%v", got, err)
	}
}
