package services

import (
	"context"
	"fmt"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

type ThreadService interface {
	Create(context.Context, string, string, string, *models.CreateThreadRequest) (*models.Channel, error)
	List(context.Context, string, string, string, bool) ([]models.Channel, error)
	Get(context.Context, string, string, string) (*models.Channel, error)
	SetArchived(context.Context, string, string, string, bool) (*models.Channel, error)
}

type threadService struct {
	channels    repository.ChannelRepository
	messages    repository.MessageRepository
	permissions ChannelPermResolver
	hub         ws.Broadcaster
}

func NewThreadService(channels repository.ChannelRepository, messages repository.MessageRepository, permissions ChannelPermResolver, hub ws.Broadcaster) ThreadService {
	return &threadService{channels: channels, messages: messages, permissions: permissions, hub: hub}
}

func (s *threadService) requireRead(ctx context.Context, userID, channelID string, send bool) error {
	p, err := s.permissions.ResolveChannelPermissions(ctx, userID, channelID)
	if err != nil {
		return err
	}
	if !models.PermCanReadChannel(p) || (send && !p.Has(models.PermSendMessages)) {
		return pkg.ErrForbidden
	}
	return nil
}

func (s *threadService) Create(ctx context.Context, serverID, parentID, actorID string, req *models.CreateThreadRequest) (*models.Channel, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, pkg.ErrText(err))
	}
	parent, err := s.channels.GetByID(ctx, parentID)
	if err != nil || parent.ServerID != serverID || parent.Type != models.ChannelTypeText {
		return nil, pkg.ErrNotFound
	}
	if err := s.requireRead(ctx, actorID, parentID, true); err != nil {
		return nil, err
	}
	starter, err := s.messages.GetByID(ctx, req.MessageID)
	if err != nil || starter.ChannelID != parentID {
		return nil, fmt.Errorf("%w: starter message not found", pkg.ErrNotFound)
	}
	ch := &models.Channel{ServerID: serverID, Name: req.Name, Type: models.ChannelTypeThread, ParentChannelID: &parentID, StarterMessageID: &req.MessageID}
	if err := s.channels.Create(ctx, ch); err != nil {
		return nil, err
	}
	s.hub.BroadcastToServer(serverID, ws.Event{Op: ws.OpChannelCreate, Data: ch})
	return ch, nil
}

func (s *threadService) List(ctx context.Context, serverID, parentID, actorID string, includeArchived bool) ([]models.Channel, error) {
	parent, err := s.channels.GetByID(ctx, parentID)
	if err != nil || parent.ServerID != serverID || parent.Type != models.ChannelTypeText {
		return nil, pkg.ErrNotFound
	}
	if err := s.requireRead(ctx, actorID, parentID, false); err != nil {
		return nil, err
	}
	return s.channels.GetThreadsByParent(ctx, parentID, includeArchived)
}

// Get returns a single thread only after validating its server and parent
// relationship and resolving the caller's current read permission on that
// parent. Archived threads remain readable when the parent is readable.
func (s *threadService) Get(ctx context.Context, serverID, threadID, actorID string) (*models.Channel, error) {
	thread, err := s.channels.GetByID(ctx, threadID)
	if err != nil || thread == nil || thread.ServerID != serverID || thread.Type != models.ChannelTypeThread || thread.ParentChannelID == nil || *thread.ParentChannelID == "" {
		return nil, pkg.ErrNotFound
	}
	parent, err := s.channels.GetByID(ctx, *thread.ParentChannelID)
	if err != nil || parent == nil || parent.ServerID != serverID || parent.Type != models.ChannelTypeText {
		return nil, pkg.ErrNotFound
	}
	if err := s.requireRead(ctx, actorID, parent.ID, false); err != nil {
		return nil, err
	}
	return thread, nil
}

func (s *threadService) SetArchived(ctx context.Context, serverID, threadID, actorID string, archived bool) (*models.Channel, error) {
	thread, err := s.channels.GetByID(ctx, threadID)
	if err != nil || thread.ServerID != serverID || thread.Type != models.ChannelTypeThread || thread.ParentChannelID == nil {
		return nil, pkg.ErrNotFound
	}
	perms, err := s.permissions.ResolveChannelPermissions(ctx, actorID, *thread.ParentChannelID)
	if err != nil {
		return nil, err
	}
	allowed := perms.Has(models.PermManageMessages)
	if !allowed && thread.StarterMessageID != nil {
		starter, getErr := s.messages.GetByID(ctx, *thread.StarterMessageID)
		allowed = getErr == nil && starter.UserID == actorID
	}
	if !allowed {
		return nil, pkg.ErrForbidden
	}
	if err := s.channels.SetThreadArchived(ctx, threadID, archived); err != nil {
		return nil, err
	}
	thread, err = s.channels.GetByID(ctx, threadID)
	if err == nil {
		s.hub.BroadcastToServer(serverID, ws.Event{Op: ws.OpChannelUpdate, Data: thread})
	}
	return thread, err
}
