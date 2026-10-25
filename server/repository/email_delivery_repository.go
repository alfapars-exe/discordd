package repository

import (
	"context"
	"errors"
	"github.com/argeinfina/hichat/models"
	"time"
)

var ErrStaleEmailDeliveryClaim = errors.New("stale email delivery claim")

type EmailDeliveryRepository interface {
	EnqueueIfEligible(context.Context, *models.EmailDeliveryJob) (bool, error)
	ClaimDue(context.Context, time.Time, int) ([]models.EmailDeliveryJob, error)
	CanDeliver(context.Context, *models.EmailDeliveryJob, time.Time) (bool, error)
	MarkDelivered(context.Context, string, string, time.Time) error
	Retry(context.Context, string, string, string, time.Time, int) error
}
