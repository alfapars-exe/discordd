package repository

import (
	"context"
	"errors"
	"time"

	"github.com/argeinfina/hichat/models"
)

var (
	ErrEmailCampaignNotFound     = errors.New("email campaign not found")
	ErrEmailCampaignExpired      = errors.New("email campaign expired")
	ErrEmailCampaignAudienceFull = errors.New("email campaign audience exceeds limit")
)

type EmailCampaignRepository interface {
	CreateDraft(context.Context, *models.EmailCampaign) error
	Get(context.Context, string) (*models.EmailCampaign, error)
	CountEligible(context.Context, string) (int, error)
	Publish(context.Context, string, string, time.Time) (*models.EmailCampaign, error)
}
