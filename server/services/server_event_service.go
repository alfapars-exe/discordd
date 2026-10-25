package services

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
)

const (
	serverEventNameMaxRunes        = 100
	serverEventDescriptionMaxRunes = 2000
	serverEventListDefaultLimit    = 50
	serverEventListMaxLimit        = 100
)

// ServerEventService owns server-wide event authorization and channel
// redaction. Event data is available to all server members; only an optional
// linked channel ID is hidden from members who cannot read that channel.
type ServerEventService interface {
	Create(context.Context, string, string, *models.CreateServerEventRequest) (*models.ServerEvent, error)
	List(context.Context, string, string, int, string) ([]models.ServerEvent, error)
	Get(context.Context, string, string, string) (*models.ServerEvent, error)
	Update(context.Context, string, string, string, *models.UpdateServerEventRequest) (*models.ServerEvent, error)
	Cancel(context.Context, string, string, string, int64) (*models.ServerEvent, error)
	SetInterested(context.Context, string, string, string, bool) error
}

type serverEventService struct {
	repo        repository.ServerEventRepository
	servers     repository.ServerRepository
	roles       repository.RoleRepository
	channels    repository.ChannelRepository
	permissions ChannelPermResolver
}

func NewServerEventService(
	repo repository.ServerEventRepository,
	servers repository.ServerRepository,
	roles repository.RoleRepository,
	channels repository.ChannelRepository,
	permissions ChannelPermResolver,
) ServerEventService {
	return &serverEventService{repo: repo, servers: servers, roles: roles, channels: channels, permissions: permissions}
}

func (s *serverEventService) requireMember(ctx context.Context, serverID, userID string) error {
	if serverID == "" || userID == "" {
		return pkg.ErrUnauthorized
	}
	member, err := s.servers.IsMember(ctx, serverID, userID)
	if err != nil {
		return err
	}
	if !member {
		return pkg.ErrForbidden
	}
	return nil
}

func (s *serverEventService) requireManager(ctx context.Context, serverID, userID string) error {
	roles, err := s.roles.GetByUserIDAndServer(ctx, userID, serverID)
	if err != nil {
		return err
	}
	var effective models.Permission
	for _, role := range roles {
		// The repository is scoped by both IDs. Ignore an unexpected cross-server
		// row rather than letting a faulty implementation grant manager access.
		if role.ServerID == serverID {
			effective |= role.Permissions
		}
	}
	if !effective.Has(models.PermManageEvents) {
		return pkg.ErrForbidden
	}
	return nil
}

func normalizeEventFields(name, description, startsAt string, endsAt, channelID *string) (string, string, string, *string, *string, error) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > serverEventNameMaxRunes ||
		utf8.RuneCountInString(description) > serverEventDescriptionMaxRunes {
		return "", "", "", nil, nil, pkg.ErrBadRequest
	}

	startTime, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(startsAt))
	if err != nil {
		return "", "", "", nil, nil, pkg.ErrBadRequest
	}
	now := time.Now().UTC()
	if !startTime.After(now) || startTime.After(now.AddDate(1, 0, 0)) {
		return "", "", "", nil, nil, pkg.ErrBadRequest
	}
	startsAt = startTime.UTC().Format(time.RFC3339Nano)

	var normalizedEnd *string
	if endsAt != nil {
		value := strings.TrimSpace(*endsAt)
		endTime, parseErr := time.Parse(time.RFC3339Nano, value)
		if parseErr != nil || !endTime.After(startTime) {
			return "", "", "", nil, nil, pkg.ErrBadRequest
		}
		endValue := endTime.UTC().Format(time.RFC3339Nano)
		normalizedEnd = &endValue
	}

	var normalizedChannel *string
	if channelID != nil {
		value := strings.TrimSpace(*channelID)
		if value == "" {
			return "", "", "", nil, nil, pkg.ErrBadRequest
		}
		normalizedChannel = &value
	}
	return name, description, startsAt, normalizedEnd, normalizedChannel, nil
}

func (s *serverEventService) validateChannel(ctx context.Context, serverID, actorID string, channelID *string) error {
	if channelID == nil {
		return nil
	}
	channel, err := s.channels.GetByID(ctx, *channelID)
	if err != nil {
		if errors.Is(err, pkg.ErrNotFound) {
			return pkg.ErrNotFound
		}
		return err
	}
	if channel == nil || channel.ServerID != serverID {
		return pkg.ErrNotFound
	}
	permissions, err := s.permissions.ResolveChannelPermissions(ctx, actorID, *channelID)
	if err != nil {
		return err
	}
	if !models.PermCanReadChannel(permissions) {
		return pkg.ErrForbidden
	}
	return nil
}

// redactChannel hides only the channel association. Event names, descriptions,
// and schedule remain server-wide even when the linked channel is private.
func (s *serverEventService) redactChannel(ctx context.Context, viewerID, serverID string, event *models.ServerEvent) {
	if event == nil || event.ChannelID == nil {
		return
	}
	channel, err := s.channels.GetByID(ctx, *event.ChannelID)
	if err != nil || channel == nil || channel.ServerID != serverID {
		event.ChannelID = nil
		return
	}
	perms, err := s.permissions.ResolveChannelPermissions(ctx, viewerID, *event.ChannelID)
	if err != nil || !models.PermCanReadChannel(perms) {
		event.ChannelID = nil
	}
}

func (s *serverEventService) attachViewerInterest(ctx context.Context, viewerID string, event *models.ServerEvent) error {
	if event == nil {
		return pkg.ErrNotFound
	}
	interested, err := s.repo.IsInterested(ctx, event.ID, viewerID)
	if err != nil {
		return err
	}
	event.Interested = interested
	return nil
}

func (s *serverEventService) Create(ctx context.Context, serverID, actorID string, req *models.CreateServerEventRequest) (*models.ServerEvent, error) {
	if err := s.requireMember(ctx, serverID, actorID); err != nil {
		return nil, err
	}
	if err := s.requireManager(ctx, serverID, actorID); err != nil {
		return nil, err
	}
	if req == nil {
		return nil, pkg.ErrBadRequest
	}
	name, description, startsAt, endsAt, channelID, err := normalizeEventFields(req.Name, req.Description, req.StartsAt, req.EndsAt, req.ChannelID)
	if err != nil {
		return nil, err
	}
	if err := s.validateChannel(ctx, serverID, actorID, channelID); err != nil {
		return nil, err
	}
	event := &models.ServerEvent{
		ServerID: serverID, CreatorID: actorID, Name: name, Description: description,
		StartsAt: startsAt, EndsAt: endsAt, ChannelID: channelID,
		Status: models.ServerEventStatusScheduled, Version: 1,
	}
	if err := s.repo.Create(ctx, event); err != nil {
		return nil, err
	}
	if err := s.attachViewerInterest(ctx, actorID, event); err != nil {
		return nil, err
	}
	s.redactChannel(ctx, actorID, serverID, event)
	return event, nil
}

func (s *serverEventService) List(ctx context.Context, serverID, actorID string, limit int, beforeID string) ([]models.ServerEvent, error) {
	if err := s.requireMember(ctx, serverID, actorID); err != nil {
		return nil, err
	}
	if limit < 1 || limit > serverEventListMaxLimit {
		limit = serverEventListDefaultLimit
	}
	events, err := s.repo.List(ctx, serverID, limit, beforeID)
	if err != nil {
		return nil, err
	}
	for i := range events {
		if err := s.attachViewerInterest(ctx, actorID, &events[i]); err != nil {
			return nil, err
		}
		s.redactChannel(ctx, actorID, serverID, &events[i])
	}
	return events, nil
}

func (s *serverEventService) Get(ctx context.Context, serverID, eventID, actorID string) (*models.ServerEvent, error) {
	if err := s.requireMember(ctx, serverID, actorID); err != nil {
		return nil, err
	}
	event, err := s.repo.GetByID(ctx, serverID, eventID)
	if err != nil {
		return nil, err
	}
	if err := s.attachViewerInterest(ctx, actorID, event); err != nil {
		return nil, err
	}
	s.redactChannel(ctx, actorID, serverID, event)
	return event, nil
}

func (s *serverEventService) Update(ctx context.Context, serverID, eventID, actorID string, req *models.UpdateServerEventRequest) (*models.ServerEvent, error) {
	if err := s.requireMember(ctx, serverID, actorID); err != nil {
		return nil, err
	}
	if err := s.requireManager(ctx, serverID, actorID); err != nil {
		return nil, err
	}
	if req == nil || req.ExpectedVersion < 1 {
		return nil, pkg.ErrBadRequest
	}
	event, err := s.repo.GetByID(ctx, serverID, eventID)
	if err != nil {
		return nil, err
	}
	name, description, startsAt, endsAt, channelID, err := normalizeEventFields(req.Name, req.Description, req.StartsAt, req.EndsAt, req.ChannelID)
	if err != nil {
		return nil, err
	}
	if err := s.validateChannel(ctx, serverID, actorID, channelID); err != nil {
		return nil, err
	}
	event.Name, event.Description, event.StartsAt = name, description, startsAt
	event.EndsAt, event.ChannelID = endsAt, channelID
	updated, err := s.repo.UpdateCAS(ctx, event, req.ExpectedVersion)
	if err != nil {
		return nil, err
	}
	if !updated {
		return nil, pkg.ErrConflict
	}
	if err := s.attachViewerInterest(ctx, actorID, event); err != nil {
		return nil, err
	}
	s.redactChannel(ctx, actorID, serverID, event)
	return event, nil
}

func (s *serverEventService) Cancel(ctx context.Context, serverID, eventID, actorID string, expectedVersion int64) (*models.ServerEvent, error) {
	if err := s.requireMember(ctx, serverID, actorID); err != nil {
		return nil, err
	}
	if err := s.requireManager(ctx, serverID, actorID); err != nil {
		return nil, err
	}
	if expectedVersion < 1 {
		return nil, pkg.ErrBadRequest
	}
	if _, err := s.repo.GetByID(ctx, serverID, eventID); err != nil {
		return nil, err
	}
	cancelled, err := s.repo.CancelCAS(ctx, serverID, eventID, expectedVersion)
	if err != nil {
		return nil, err
	}
	if !cancelled {
		return nil, pkg.ErrConflict
	}
	event, err := s.repo.GetByID(ctx, serverID, eventID)
	if err != nil {
		return nil, err
	}
	if err := s.attachViewerInterest(ctx, actorID, event); err != nil {
		return nil, err
	}
	s.redactChannel(ctx, actorID, serverID, event)
	return event, nil
}

func (s *serverEventService) SetInterested(ctx context.Context, serverID, eventID, userID string, interested bool) error {
	if err := s.requireMember(ctx, serverID, userID); err != nil {
		return err
	}
	event, err := s.repo.GetByID(ctx, serverID, eventID)
	if err != nil {
		return err
	}
	if interested {
		startsAt, parseErr := time.Parse(time.RFC3339Nano, event.StartsAt)
		if parseErr != nil || event.Status != models.ServerEventStatusScheduled || !startsAt.After(time.Now()) {
			return pkg.ErrConflict
		}
	}
	return s.repo.SetInterested(ctx, eventID, userID, interested)
}

var _ ServerEventService = (*serverEventService)(nil)
