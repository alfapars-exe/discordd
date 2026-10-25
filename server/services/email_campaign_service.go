package services

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
)

type EmailCampaignService interface {
	CreateDraft(context.Context, string, *models.CreateEmailCampaignRequest) (*models.EmailCampaign, error)
	Preview(context.Context, string) (*models.EmailCampaignPreview, error)
	Publish(context.Context, string, string) (*models.EmailCampaign, error)
}

type emailCampaignService struct {
	repo repository.EmailCampaignRepository
	now  func() time.Time
}

func NewEmailCampaignService(repo repository.EmailCampaignRepository) EmailCampaignService {
	return &emailCampaignService{repo: repo, now: time.Now}
}

func (s *emailCampaignService) CreateDraft(ctx context.Context, adminID string, request *models.CreateEmailCampaignRequest) (*models.EmailCampaign, error) {
	if s == nil || s.repo == nil {
		return nil, fmt.Errorf("email campaigns unavailable")
	}
	if adminID == "" || request == nil {
		return nil, pkg.ErrBadRequest
	}
	now := s.now().UTC()
	if err := request.Validate(now); err != nil {
		return nil, fmt.Errorf("%w: invalid campaign", pkg.ErrBadRequest)
	}
	expires, _ := time.Parse(time.RFC3339Nano, request.ExpiresAt)
	var randomID [16]byte
	if _, err := rand.Read(randomID[:]); err != nil {
		return nil, fmt.Errorf("email campaign ID generation failed")
	}
	campaign := &models.EmailCampaign{
		ID: "ec_" + hex.EncodeToString(randomID[:]), Category: request.Category,
		Subject: request.Subject, Body: request.Body, Status: "draft",
		ExpiresAt: expires.UTC().Format(time.RFC3339Nano), CreatedBy: adminID,
		CreatedAt: now.Format(time.RFC3339Nano),
	}
	if err := s.repo.CreateDraft(ctx, campaign); err != nil {
		return nil, fmt.Errorf("email campaign draft unavailable")
	}
	return campaign, nil
}

func (s *emailCampaignService) Preview(ctx context.Context, campaignID string) (*models.EmailCampaignPreview, error) {
	if s == nil || s.repo == nil {
		return nil, fmt.Errorf("email campaigns unavailable")
	}
	campaign, err := s.repo.Get(ctx, campaignID)
	if err != nil {
		if errors.Is(err, repository.ErrEmailCampaignNotFound) {
			return nil, pkg.ErrNotFound
		}
		return nil, fmt.Errorf("email campaign lookup failed")
	}
	count := campaign.RecipientCount
	if campaign.Status == "draft" {
		count, err = s.repo.CountEligible(ctx, campaign.Category)
		if errors.Is(err, repository.ErrEmailCampaignAudienceFull) {
			return nil, fmt.Errorf("%w: eligible audience exceeds campaign limit", pkg.ErrBadRequest)
		}
		if err != nil {
			return nil, fmt.Errorf("email campaign audience lookup failed")
		}
	}
	return &models.EmailCampaignPreview{
		Campaign: campaign, BodyHTML: models.RenderEmailCampaignBody(campaign.Body), EligibleRecipients: count,
	}, nil
}

func (s *emailCampaignService) Publish(ctx context.Context, adminID, campaignID string) (*models.EmailCampaign, error) {
	if s == nil || s.repo == nil || adminID == "" {
		return nil, pkg.ErrBadRequest
	}
	campaign, err := s.repo.Publish(ctx, campaignID, adminID, s.now().UTC())
	if errors.Is(err, repository.ErrEmailCampaignNotFound) {
		return nil, pkg.ErrNotFound
	}
	if errors.Is(err, repository.ErrEmailCampaignExpired) {
		return nil, fmt.Errorf("%w: campaign is expired or unavailable for publication", pkg.ErrConflict)
	}
	if errors.Is(err, repository.ErrEmailCampaignAudienceFull) {
		return nil, fmt.Errorf("%w: eligible audience exceeds campaign limit", pkg.ErrBadRequest)
	}
	if err != nil {
		return nil, fmt.Errorf("email campaign publish failed")
	}
	return campaign, nil
}

var _ EmailCampaignService = (*emailCampaignService)(nil)
