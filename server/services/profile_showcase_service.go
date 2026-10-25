package services

import (
	"context"
	"errors"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
)

type ProfileShowcaseService interface {
	Get(context.Context, string, string) (*models.ProfileShowcase, error)
	GetPublic(context.Context, string, string, string) (*models.ProfileShowcase, error)
	Put(context.Context, string, string, *models.ProfileShowcase, int64) (*models.ProfileShowcase, error)
}

type profileShowcaseService struct {
	repo     repository.ProfileShowcaseRepository
	servers  repository.ServerRepository
	audience ProfileAudiencePolicy
}

func NewProfileShowcaseService(repo repository.ProfileShowcaseRepository, servers repository.ServerRepository, audience ProfileAudiencePolicy) ProfileShowcaseService {
	return &profileShowcaseService{repo: repo, servers: servers, audience: audience}
}

func (s *profileShowcaseService) GetPublic(ctx context.Context, viewerID, targetID, scope string) (*models.ProfileShowcase, error) {
	if viewerID == "" || targetID == "" {
		return nil, pkg.ErrUnauthorized
	}
	allowed, err := s.audience.CanView(ctx, viewerID, targetID)
	if err != nil {
		return nil, err
	}
	if !allowed {
		return nil, pkg.ErrNotFound
	}
	if scope != "" {
		viewerMember, err := s.servers.IsMember(ctx, scope, viewerID)
		if err != nil {
			return nil, err
		}
		targetMember, err := s.servers.IsMember(ctx, scope, targetID)
		if err != nil {
			return nil, err
		}
		if !viewerMember || !targetMember {
			return nil, pkg.ErrNotFound
		}
	}
	out, err := s.repo.Get(ctx, targetID, scope)
	if err != nil {
		return nil, err
	}
	visible := out.Links[:0]
	for _, link := range out.Links {
		if link.Visible {
			visible = append(visible, link)
		}
	}
	out.Links = visible
	return out, nil
}

func (s *profileShowcaseService) authorizeScope(ctx context.Context, userID, scope string) error {
	if scope == "" {
		return nil
	}
	ok, err := s.servers.IsMember(ctx, scope, userID)
	if err != nil {
		return err
	}
	if !ok {
		return pkg.ErrForbidden
	}
	return nil
}

func (s *profileShowcaseService) Get(ctx context.Context, userID, scope string) (*models.ProfileShowcase, error) {
	if userID == "" {
		return nil, pkg.ErrUnauthorized
	}
	if err := s.authorizeScope(ctx, userID, scope); err != nil {
		return nil, err
	}
	return s.repo.Get(ctx, userID, scope)
}

func (s *profileShowcaseService) Put(ctx context.Context, userID, scope string, in *models.ProfileShowcase, expected int64) (*models.ProfileShowcase, error) {
	if userID == "" {
		return nil, pkg.ErrUnauthorized
	}
	if in == nil || expected < 0 {
		return nil, pkg.ErrBadRequest
	}
	if err := s.authorizeScope(ctx, userID, scope); err != nil {
		return nil, err
	}
	in.ScopeServerID = ""
	in.Version = 0
	in.UpdatedAt = ""
	if err := in.Validate(); err != nil {
		if errors.Is(err, models.ErrProfileShowcaseInvalid) {
			return nil, pkg.ErrBadRequest
		}
		return nil, err
	}
	return s.repo.Put(ctx, userID, scope, in, expected)
}
