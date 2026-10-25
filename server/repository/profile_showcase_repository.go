package repository

import (
	"context"
	"github.com/argeinfina/hichat/models"
)

type ProfileShowcaseRepository interface {
	Get(context.Context, string, string) (*models.ProfileShowcase, error)
	Put(context.Context, string, string, *models.ProfileShowcase, int64) (*models.ProfileShowcase, error)
}
