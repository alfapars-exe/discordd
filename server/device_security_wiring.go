package main

import (
	"database/sql"
	"github.com/argeinfina/hichat/pkg/crypto"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
)

type deviceSecurityDependencies struct {
	Database      *sql.DB
	Repositories  *Repositories
	Hub           ws.Broadcaster
	Permissions   services.ChannelPermResolver
	EncryptionKey []byte
}
type deviceSecurityServices struct {
	Device services.DeviceService
	E2EE   services.E2EEService
}

// initDeviceSecurityServices binds transactional device registration and key
// distribution to the same membership, channel and permission providers.
func initDeviceSecurityServices(deps deviceSecurityDependencies) deviceSecurityServices {
	for _, input := range []struct {
		name  string
		value any
	}{
		{"Database", deps.Database}, {"Repositories", deps.Repositories}, {"Hub", deps.Hub}, {"Permissions", deps.Permissions},
	} {
		if missingCompositionInput(input.value) {
			panic("device security requires " + input.name)
		}
	}
	repos := deps.Repositories
	for _, input := range []struct {
		name  string
		value any
	}{
		{"Device", repos.Device}, {"Server", repos.Server}, {"E2EEBackup", repos.E2EEBackup}, {"GroupSession", repos.GroupSession}, {"Channel", repos.Channel},
	} {
		if missingCompositionInput(input.value) {
			panic("device security requires repository " + input.name)
		}
	}
	device := services.NewDeviceService(repos.Device, repository.NewDeviceTxRunner(deps.Database), deps.Hub, repos.Server)
	// Derive the backup integrity MAC key from the server master key, retaining
	// the existing HKDF domain separation and opaque encrypted backup contract.
	backupHMACKey := crypto.DeriveBackupHMACKey(deps.EncryptionKey)
	e2ee := services.NewE2EEService(repos.E2EEBackup, repos.GroupSession, repos.Device, repos.Server, deps.Hub, repos.Channel, deps.Permissions, backupHMACKey)
	return deviceSecurityServices{Device: device, E2EE: e2ee}
}
