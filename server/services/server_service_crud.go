// Package services — server lifecycle CRUD: create, read, update, icon, and delete.
package services

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/crypto"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

// CreateServer creates a new server atomically (server + membership + roles + channels in one tx).
func (s *serverService) CreateServer(ctx context.Context, ownerID string, req *models.CreateServerRequest) (*models.Server, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %v", pkg.ErrBadRequest, err)
	}

	// Non-admin users can own at most 1 mqvi-hosted server
	if req.HostType == "mqvi_hosted" {
		user, err := s.userRepo.GetByID(ctx, ownerID)
		if err != nil {
			return nil, fmt.Errorf("failed to get user: %w", err)
		}
		if !user.IsPlatformAdmin {
			count, err := s.serverRepo.CountOwnedMqviHostedServers(ctx, ownerID)
			if err != nil {
				return nil, fmt.Errorf("failed to count owned servers: %w", err)
			}
			if count >= 1 {
				return nil, fmt.Errorf("%w: you can only own 1 mqvi-hosted server, you can create unlimited self-hosted servers", pkg.ErrBadRequest)
			}
		}
	}

	// ─── LiveKit instance setup (outside transaction) ───
	var livekitInstanceID *string

	switch req.HostType {
	case "self_hosted":
		if req.LiveKitURL == "" || req.LiveKitKey == "" || req.LiveKitSecret == "" {
			return nil, fmt.Errorf("%w: livekit_url, livekit_key, and livekit_secret are required for self-hosted", pkg.ErrBadRequest)
		}

		encKey, err := crypto.Encrypt(req.LiveKitKey, s.encryptionKey)
		if err != nil {
			return nil, fmt.Errorf("failed to encrypt livekit key: %w", err)
		}
		encSecret, err := crypto.Encrypt(req.LiveKitSecret, s.encryptionKey)
		if err != nil {
			return nil, fmt.Errorf("failed to encrypt livekit secret: %w", err)
		}

		instance := &models.LiveKitInstance{
			URL:               req.LiveKitURL,
			APIKey:            encKey,
			APISecret:         encSecret,
			IsPlatformManaged: false,
			ServerCount:       1,
		}

		if err := s.livekitRepo.Create(ctx, instance); err != nil {
			return nil, fmt.Errorf("failed to create livekit instance: %w", err)
		}

		livekitInstanceID = &instance.ID

	case "mqvi_hosted":
		instance, err := s.livekitRepo.GetLeastLoadedPlatformInstance(ctx)
		if err != nil {
			serverLogger.Warn("no platform livekit instance available, creating server without voice", "err", pkg.ErrText(err))
		} else {
			livekitInstanceID = &instance.ID
			if err := s.livekitRepo.IncrementServerCount(ctx, instance.ID); err != nil {
				return nil, fmt.Errorf("failed to increment server count: %w", err)
			}
		}

	default:
		// No voice support
	}

	// ─── Atomic transaction: server + membership + roles + channels ───
	server := &models.Server{
		Name:              req.Name,
		OwnerID:           ownerID,
		InviteRequired:    false,
		LiveKitInstanceID: livekitInstanceID,
	}

	err := database.WithTx(ctx, s.db, func(tx *sql.Tx) error {
		txServerRepo := repository.NewSQLiteServerRepo(tx)
		txRoleRepo := repository.NewSQLiteRoleRepo(tx)
		txChannelRepo := repository.NewSQLiteChannelRepo(tx)
		txCategoryRepo := repository.NewSQLiteCategoryRepo(tx)

		if err := txServerRepo.Create(ctx, server); err != nil {
			return fmt.Errorf("failed to create server: %w", err)
		}

		if err := txServerRepo.AddMember(ctx, server.ID, ownerID); err != nil {
			return fmt.Errorf("failed to add owner as member: %w", err)
		}

		// Default "everyone" role
		defaultPerms := models.PermViewChannel | models.PermReadMessages | models.PermSendMessages |
			models.PermConnectVoice | models.PermSpeak | models.PermUseSoundboard

		defaultRole := &models.Role{
			ServerID:    server.ID,
			Name:        "everyone",
			Color:       "#99AAB5",
			Position:    1,
			Permissions: defaultPerms,
			IsDefault:   true,
			Mentionable: true,
		}
		if err := txRoleRepo.Create(ctx, defaultRole); err != nil {
			return fmt.Errorf("failed to create default role: %w", err)
		}

		// Owner role — highest position, full permissions
		ownerRole := &models.Role{
			ServerID:    server.ID,
			Name:        "Owner",
			Color:       "#E74C3C",
			Position:    100,
			Permissions: models.PermAll,
			IsOwner:     true,
		}
		if err := txRoleRepo.Create(ctx, ownerRole); err != nil {
			return fmt.Errorf("failed to create owner role: %w", err)
		}

		if err := txRoleRepo.AssignToUser(ctx, ownerID, defaultRole.ID, server.ID); err != nil {
			return fmt.Errorf("failed to assign default role to owner: %w", err)
		}
		if err := txRoleRepo.AssignToUser(ctx, ownerID, ownerRole.ID, server.ID); err != nil {
			return fmt.Errorf("failed to assign owner role: %w", err)
		}

		// Default categories + channels
		textCategory := &models.Category{
			ServerID: server.ID,
			Name:     "Text Channels",
			Position: 0,
		}
		if err := txCategoryRepo.Create(ctx, textCategory); err != nil {
			return fmt.Errorf("failed to create text category: %w", err)
		}

		voiceCategory := &models.Category{
			ServerID: server.ID,
			Name:     "Voice Channels",
			Position: 1,
		}
		if err := txCategoryRepo.Create(ctx, voiceCategory); err != nil {
			return fmt.Errorf("failed to create voice category: %w", err)
		}

		textChannel := &models.Channel{
			ServerID:   server.ID,
			Name:       "general",
			Type:       models.ChannelTypeText,
			CategoryID: &textCategory.ID,
			Position:   0,
		}
		if err := txChannelRepo.Create(ctx, textChannel); err != nil {
			return fmt.Errorf("failed to create default text channel: %w", err)
		}

		voiceChannel := &models.Channel{
			ServerID:   server.ID,
			Name:       "General",
			Type:       models.ChannelTypeVoice,
			CategoryID: &voiceCategory.ID,
			Position:   0,
			// Match the system-wide default in channel_service.Create —
			// hi-fi Opus out of the box. See migration 068 for backfill of
			// pre-existing servers' voice channels.
			Bitrate: 384000,
		}
		if err := txChannelRepo.Create(ctx, voiceChannel); err != nil {
			return fmt.Errorf("failed to create default voice channel: %w", err)
		}

		// Audit channel — server-wide moderation event feed. One per server,
		// non-deletable, non-renamable (enforced in channel_service). Placed
		// in no category (uncategorized) at high position so it sits at the
		// bottom of the sidebar by default. Audit-view permission filter on
		// fetch hides it from non-mods, so regular members won't even see it.
		auditChannel := &models.Channel{
			ServerID: server.ID,
			Name:     "denetim",
			Type:     models.ChannelTypeAudit,
			Position: 9999,
		}
		if err := txChannelRepo.Create(ctx, auditChannel); err != nil {
			return fmt.Errorf("failed to create audit channel: %w", err)
		}

		return nil
	})

	if err != nil {
		return nil, fmt.Errorf("failed to create server (transaction): %w", err)
	}

	// WS broadcast (after commit)
	s.hub.AddClientServerID(ownerID, server.ID)
	s.hub.BroadcastToUser(ownerID, ws.Event{
		Op: ws.OpServerCreate,
		Data: models.ServerListItem{
			ID:      server.ID,
			Name:    server.Name,
			IconURL: server.IconURL,
		},
	})

	serverLogger.Info("created server", "server_id", server.ID, "name", server.Name, "owner_id", ownerID, "host_type", req.HostType)

	return server, nil
}

func (s *serverService) GetServer(ctx context.Context, serverID string) (*models.Server, error) {
	return s.serverRepo.GetByID(ctx, serverID)
}

func (s *serverService) GetUserServers(ctx context.Context, userID string) ([]models.ServerListItem, error) {
	return s.serverRepo.GetUserServers(ctx, userID)
}

func (s *serverService) UpdateServer(ctx context.Context, serverID string, req *models.UpdateServerRequest) (*models.Server, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %v", pkg.ErrBadRequest, err)
	}

	server, err := s.serverRepo.GetByID(ctx, serverID)
	if err != nil {
		return nil, err
	}

	if req.Name != nil {
		server.Name = *req.Name
	}
	if req.InviteRequired != nil {
		server.InviteRequired = *req.InviteRequired
	}
	if req.E2EEEnabled != nil {
		server.E2EEEnabled = *req.E2EEEnabled
	}
	if req.AFKTimeoutMinutes != nil {
		server.AFKTimeoutMinutes = *req.AFKTimeoutMinutes
	}

	if err := s.serverRepo.Update(ctx, server); err != nil {
		return nil, fmt.Errorf("failed to update server: %w", err)
	}

	// LiveKit credential update (self-hosted only)
	if req.HasLiveKitUpdate() {
		if server.LiveKitInstanceID == nil {
			return nil, fmt.Errorf("%w: this server has no LiveKit instance", pkg.ErrBadRequest)
		}

		instance, err := s.livekitRepo.GetByID(ctx, *server.LiveKitInstanceID)
		if err != nil {
			return nil, fmt.Errorf("failed to get livekit instance: %w", err)
		}
		if instance.IsPlatformManaged {
			return nil, fmt.Errorf("%w: cannot modify platform-managed LiveKit instance", pkg.ErrForbidden)
		}

		encKey, err := crypto.Encrypt(*req.LiveKitKey, s.encryptionKey)
		if err != nil {
			return nil, fmt.Errorf("failed to encrypt livekit key: %w", err)
		}
		encSecret, err := crypto.Encrypt(*req.LiveKitSecret, s.encryptionKey)
		if err != nil {
			return nil, fmt.Errorf("failed to encrypt livekit secret: %w", err)
		}

		instance.URL = *req.LiveKitURL
		instance.APIKey = encKey
		instance.APISecret = encSecret

		if err := s.livekitRepo.Update(ctx, instance); err != nil {
			return nil, fmt.Errorf("failed to update livekit instance: %w", err)
		}

		serverLogger.Info("livekit credentials updated", "server_id", serverID)
	}

	s.hub.BroadcastToServer(serverID, ws.Event{
		Op:   ws.OpServerUpdate,
		Data: server,
	})

	return server, nil
}

func (s *serverService) UpdateIcon(ctx context.Context, serverID, iconURL string) (*models.Server, error) {
	server, err := s.serverRepo.GetByID(ctx, serverID)
	if err != nil {
		return nil, err
	}

	server.IconURL = &iconURL

	if err := s.serverRepo.Update(ctx, server); err != nil {
		return nil, fmt.Errorf("failed to update server icon: %w", err)
	}

	s.hub.BroadcastToServer(serverID, ws.Event{
		Op:   ws.OpServerUpdate,
		Data: server,
	})

	return server, nil
}

func (s *serverService) DeleteServer(ctx context.Context, serverID, userID string) error {
	server, err := s.serverRepo.GetByID(ctx, serverID)
	if err != nil {
		return err
	}

	if server.OwnerID != userID {
		return fmt.Errorf("%w: only the server owner can delete the server", pkg.ErrForbidden)
	}

	// LiveKit cleanup: delete self-hosted instance, decrement platform instance
	if server.LiveKitInstanceID != nil {
		instance, err := s.livekitRepo.GetByID(ctx, *server.LiveKitInstanceID)
		if err == nil {
			if instance.IsPlatformManaged {
				if decErr := s.livekitRepo.DecrementServerCount(ctx, instance.ID); decErr != nil {
					serverLogger.Error("failed to decrement livekit server count", "instance_id", instance.ID, "err", pkg.ErrText(decErr))
				}
			} else {
				if delErr := s.livekitRepo.Delete(ctx, instance.ID); delErr != nil {
					serverLogger.Error("failed to delete self-hosted livekit instance", "instance_id", instance.ID, "err", pkg.ErrText(delErr))
				}
			}
		}
	}

	// Broadcast before delete (server_members are needed for BroadcastToServer)
	s.hub.BroadcastToServer(serverID, ws.Event{
		Op:   ws.OpServerDelete,
		Data: map[string]string{"id": serverID},
	})

	// Pre-fetch attachment file_urls for the post-delete disk cleanup below.
	// A fetch failure here is logged and non-fatal — the delete still
	// proceeds, it just can't clean up files it couldn't enumerate.
	fileURLs, urlErr := s.serverRepo.GetFileURLsByServerID(ctx, serverID)
	if urlErr != nil {
		serverLogger.Error("failed to fetch file urls before server delete", "server_id", serverID, "err", pkg.ErrText(urlErr))
	}

	// Transactional so the cascade (channels, roles, messages, ...) and the
	// server row either all go or none do — Delete alone, called on the
	// pool-bound repo, would run each table's delete as its own
	// auto-committed statement and could strand a half-cleaned server on a
	// mid-cascade failure.
	if err := database.WithTx(ctx, s.db, func(tx *sql.Tx) error {
		return repository.NewSQLiteServerRepo(tx).Delete(ctx, serverID)
	}); err != nil {
		return fmt.Errorf("failed to delete server: %w", err)
	}

	// Only remove files once the DB delete has actually committed — see
	// upload_cleanup.go for why the ordering matters.
	removeUploadFilesByURL(s.uploadDir, fileURLs)

	serverLogger.Info("deleted server", "server_id", serverID, "user_id", userID)
	return nil
}
