package services

import (
	"context"
	"fmt"
	"log"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

// ChannelVisibilityChecker resolves per-user channel visibility using role overrides.
type ChannelVisibilityChecker interface {
	BuildVisibilityFilter(ctx context.Context, userID, serverID string) (*ChannelVisibilityFilter, error)
}

// UserVoiceChannelProvider returns the user's active voice channel ID.
// Used to force-include voice-connected channels in sidebar even without ViewChannel.
type UserVoiceChannelProvider interface {
	GetUserVoiceChannelID(userID string) string
}

type ChannelVisibilityFilter struct {
	IsAdmin         bool
	HasBaseView     bool
	HiddenChannels  map[string]bool
	GrantedChannels map[string]bool
}

func (f *ChannelVisibilityFilter) CanSee(channelID string) bool {
	if f.IsAdmin {
		return true
	}
	if f.HiddenChannels[channelID] {
		return false
	}
	if f.GrantedChannels[channelID] {
		return true
	}
	return f.HasBaseView
}

// ChannelService handles channel CRUD. All list operations are server-scoped.
type ChannelService interface {
	GetAllGrouped(ctx context.Context, serverID, userID string) ([]models.CategoryWithChannels, error)
	Create(ctx context.Context, serverID, actorID string, req *models.CreateChannelRequest) (*models.Channel, error)
	Update(ctx context.Context, serverID, actorID, id string, req *models.UpdateChannelRequest) (*models.Channel, error)
	Delete(ctx context.Context, serverID, actorID, id string) error
	ReorderChannels(ctx context.Context, serverID string, req *models.ReorderChannelsRequest, userID string) ([]models.CategoryWithChannels, error)
	SetAuditLogger(logger AuditWriter)
}

type channelService struct {
	channelRepo   repository.ChannelRepository
	categoryRepo  repository.CategoryRepository
	hub           ws.Broadcaster
	visChecker    ChannelVisibilityChecker
	voiceProvider UserVoiceChannelProvider
	auditLogger   AuditWriter
}

func (s *channelService) SetAuditLogger(logger AuditWriter) {
	s.auditLogger = logger
}

// audit emits an audit log event if an audit logger is wired. Nil-safe.
// Same observability pattern as member/role/voice: both branches log so a
// "I created/renamed/deleted a channel but audit channel stayed empty"
// report tells us exactly where the pipeline dropped.
func (s *channelService) audit(entry models.AuditLog) {
	if s.auditLogger == nil {
		log.Printf("[channel/audit] DROPPED event=%s server=%s (auditLogger not wired)", entry.EventType, entry.ServerID)
		return
	}
	log.Printf("[channel/audit] emit event=%s server=%s", entry.EventType, entry.ServerID)
	s.auditLogger.Write(entry)
}

func NewChannelService(
	channelRepo repository.ChannelRepository,
	categoryRepo repository.CategoryRepository,
	hub ws.Broadcaster,
	visChecker ChannelVisibilityChecker,
	voiceProvider UserVoiceChannelProvider,
) ChannelService {
	return &channelService{
		channelRepo:   channelRepo,
		categoryRepo:  categoryRepo,
		hub:           hub,
		visChecker:    visChecker,
		voiceProvider: voiceProvider,
	}
}

func (s *channelService) GetAllGrouped(ctx context.Context, serverID, userID string) ([]models.CategoryWithChannels, error) {
	categories, err := s.categoryRepo.GetAllByServer(ctx, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to get categories: %w", err)
	}

	channels, err := s.channelRepo.GetAllByServer(ctx, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to get channels: %w", err)
	}

	filter, err := s.visChecker.BuildVisibilityFilter(ctx, userID, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to build visibility filter: %w", err)
	}

	// Force-include the user's active voice channel even without ViewChannel
	voiceChannelID := ""
	if s.voiceProvider != nil {
		voiceChannelID = s.voiceProvider.GetUserVoiceChannelID(userID)
	}

	channelsByCategory := make(map[string][]models.Channel)
	for _, ch := range channels {
		if !filter.CanSee(ch.ID) && ch.ID != voiceChannelID {
			continue
		}
		catID := ""
		if ch.CategoryID != nil {
			catID = *ch.CategoryID
		}
		channelsByCategory[catID] = append(channelsByCategory[catID], ch)
	}

	result := make([]models.CategoryWithChannels, 0, len(categories)+1)

	// Uncategorized channels first (category_id = NULL)
	if uncategorized := channelsByCategory[""]; len(uncategorized) > 0 {
		result = append(result, models.CategoryWithChannels{
			Category: models.Category{
				ID:       "",
				ServerID: serverID,
				Name:     "",
				Position: -1,
			},
			Channels: uncategorized,
		})
	}

	for _, cat := range categories {
		chs := channelsByCategory[cat.ID]
		if len(chs) == 0 && !filter.IsAdmin {
			continue
		}
		if chs == nil {
			chs = []models.Channel{}
		}
		result = append(result, models.CategoryWithChannels{
			Category: cat,
			Channels: chs,
		})
	}

	return result, nil
}

func (s *channelService) Create(ctx context.Context, serverID, actorID string, req *models.CreateChannelRequest) (*models.Channel, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	// One audit channel per server. Reject Create attempts when one
	// already exists — the auto-created channel from server_service or
	// the migration backfill is the canonical one. The radio button in
	// the create modal exists for discoverability; users who try it on a
	// server that already has an audit channel get a friendly error
	// instead of accidentally producing duplicates.
	if req.Type == string(models.ChannelTypeAudit) {
		existing, listErr := s.channelRepo.GetAllByServer(ctx, serverID)
		if listErr == nil {
			for _, ch := range existing {
				if ch.Type == models.ChannelTypeAudit {
					return nil, fmt.Errorf("%w: this server already has an audit channel", pkg.ErrBadRequest)
				}
			}
		}
	}

	if req.CategoryID != "" {
		category, err := s.categoryRepo.GetByID(ctx, req.CategoryID)
		if err != nil {
			return nil, fmt.Errorf("%w: category not found", pkg.ErrBadRequest)
		}
		if category.ServerID != serverID {
			return nil, fmt.Errorf("%w: category not found", pkg.ErrNotFound)
		}
	}

	maxPos, err := s.channelRepo.GetMaxPosition(ctx, req.CategoryID)
	if err != nil {
		return nil, fmt.Errorf("failed to get max position: %w", err)
	}

	channel := &models.Channel{
		ServerID: serverID,
		Name:     req.Name,
		Type:     models.ChannelType(req.Type),
		Position: maxPos + 1,
	}

	if req.CategoryID != "" {
		channel.CategoryID = &req.CategoryID
	}
	if req.Topic != "" {
		channel.Topic = &req.Topic
	}
	if channel.Type == models.ChannelTypeVoice {
		// Default to the validation ceiling so newly-created voice channels
		// inherit the platform-wide hi-fi behavior. The DB column DEFAULT
		// (64000, set in 001_init.sql) is never reached because this branch
		// always assigns explicitly — see migration 068 for the matching
		// backfill of pre-existing rows.
		channel.Bitrate = 384000
	}

	if err := s.channelRepo.Create(ctx, channel); err != nil {
		return nil, fmt.Errorf("failed to create channel: %w", err)
	}

	s.hub.BroadcastToServer(serverID, ws.Event{
		Op:   ws.OpChannelCreate,
		Data: nil,
	})

	// Skip audit for the server's own auto-created denetim channel — that
	// path goes through server_service during initial setup and audit_logs
	// for a non-existent server pollute history. Real user-initiated audit
	// channel creation is blocked above (one per server), so the only call
	// reaching this point is a normal text/voice channel anyway.
	actor := actorID
	s.audit(models.AuditLog{
		ServerID:    serverID,
		ActorUserID: &actor,
		EventType:   models.AuditEventChannelCreate,
		Metadata:    fmt.Sprintf(`{"channel_name":%q,"channel_type":%q}`, channel.Name, string(channel.Type)),
	})

	return channel, nil
}

func (s *channelService) Update(ctx context.Context, serverID, actorID, id string, req *models.UpdateChannelRequest) (*models.Channel, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	channel, err := s.channelRepo.GetByID(ctx, id)
	if err != nil {
		return nil, err
	}
	if channel.ServerID != serverID {
		return nil, fmt.Errorf("%w: channel not found", pkg.ErrNotFound)
	}

	// Audit channels are renamable-restricted: the name is part of the
	// channel's identity ("denetim") and stable across servers. Category
	// move + topic edits stay allowed so the user can organize the sidebar.
	if channel.Type == models.ChannelTypeAudit && req.Name != nil && *req.Name != channel.Name {
		return nil, fmt.Errorf("%w: audit channel cannot be renamed", pkg.ErrForbidden)
	}

	// Capture old name BEFORE mutation — needed for rename audit metadata.
	oldName := channel.Name

	if req.Name != nil {
		channel.Name = *req.Name
	}
	if req.Topic != nil {
		channel.Topic = req.Topic
	}
	if req.CategoryID != nil {
		if *req.CategoryID == "" {
			channel.CategoryID = nil
		} else {
			category, err := s.categoryRepo.GetByID(ctx, *req.CategoryID)
			if err != nil {
				return nil, fmt.Errorf("%w: category not found", pkg.ErrBadRequest)
			}
			if category.ServerID != serverID {
				return nil, fmt.Errorf("%w: category not found", pkg.ErrNotFound)
			}
			channel.CategoryID = req.CategoryID
		}
	}

	// Track T1 — voice-only fields. Silently ignore when sent to a text/audit
	// channel rather than erroring. Model-level Validate() already clamped
	// both to the legal range (8000-384000 bps / 0-99 users).
	if req.Bitrate != nil && channel.Type == models.ChannelTypeVoice {
		channel.Bitrate = *req.Bitrate
	}
	if req.UserLimit != nil && channel.Type == models.ChannelTypeVoice {
		channel.UserLimit = *req.UserLimit
	}

	if err := s.channelRepo.Update(ctx, channel); err != nil {
		return nil, err
	}

	s.hub.BroadcastToServer(serverID, ws.Event{
		Op:   ws.OpChannelUpdate,
		Data: channel,
	})

	// Only the rename branch is auditable here. Topic and category-move
	// edits are too noisy (every drag-drop reorder would log) and there's
	// no i18n template for them yet — see locales/{tr,en}/audit.json.
	if oldName != channel.Name {
		actor := actorID
		s.audit(models.AuditLog{
			ServerID:    channel.ServerID,
			ActorUserID: &actor,
			EventType:   models.AuditEventChannelRename,
			Metadata:    fmt.Sprintf(`{"old_name":%q,"new_name":%q}`, oldName, channel.Name),
		})
	}

	return channel, nil
}

func (s *channelService) Delete(ctx context.Context, serverID, actorID, id string) error {
	// Audit channels are non-deletable — they hold the server's moderation
	// history and removing them would orphan audit_logs rows (FK CASCADE
	// keeps DB consistent, but UI-side users would lose access to the
	// feed without warning). Block the operation here so callers always
	// see a clear error rather than silently destroying the channel.
	existing, getErr := s.channelRepo.GetByID(ctx, id)
	if getErr != nil {
		return getErr
	}
	if existing == nil || existing.ServerID != serverID {
		return fmt.Errorf("%w: channel not found", pkg.ErrNotFound)
	}
	if existing.Type == models.ChannelTypeAudit {
		return fmt.Errorf("%w: audit channel cannot be deleted", pkg.ErrForbidden)
	}

	if err := s.channelRepo.Delete(ctx, id); err != nil {
		return err
	}

	s.hub.BroadcastToServer(serverID, ws.Event{
		Op:   ws.OpChannelDelete,
		Data: map[string]string{"id": id},
	})

	// Use the existing pre-delete snapshot for audit metadata — the row is
	// already gone from the DB, so re-fetching would fail.
	if existing != nil {
		actor := actorID
		s.audit(models.AuditLog{
			ServerID:    existing.ServerID,
			ActorUserID: &actor,
			EventType:   models.AuditEventChannelDelete,
			Metadata:    fmt.Sprintf(`{"channel_name":%q}`, existing.Name),
		})
	}

	return nil
}

func (s *channelService) ReorderChannels(ctx context.Context, serverID string, req *models.ReorderChannelsRequest, userID string) ([]models.CategoryWithChannels, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}

	for _, item := range req.Items {
		channel, err := s.channelRepo.GetByID(ctx, item.ID)
		if err != nil {
			return nil, err
		}
		if channel.ServerID != serverID {
			return nil, fmt.Errorf("%w: channel not found", pkg.ErrNotFound)
		}
		if item.CategoryID != nil && *item.CategoryID != "" {
			category, err := s.categoryRepo.GetByID(ctx, *item.CategoryID)
			if err != nil {
				return nil, fmt.Errorf("%w: category not found", pkg.ErrBadRequest)
			}
			if category.ServerID != serverID {
				return nil, fmt.Errorf("%w: category not found", pkg.ErrNotFound)
			}
		}
	}

	if err := s.channelRepo.UpdatePositions(ctx, req.Items); err != nil {
		return nil, fmt.Errorf("failed to update channel positions: %w", err)
	}

	s.hub.BroadcastToServer(serverID, ws.Event{
		Op:   ws.OpChannelReorder,
		Data: nil,
	})

	grouped, err := s.GetAllGrouped(ctx, serverID, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to reload channels after reorder: %w", err)
	}

	return grouped, nil
}
