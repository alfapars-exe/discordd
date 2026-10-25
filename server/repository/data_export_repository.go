package repository

import (
	"context"

	"github.com/argeinfina/hichat/models"
)

type DataExportRepository interface {
	Create(context.Context, *models.User) (*models.DataExportJob, error)
	Get(context.Context, string, string) (*models.DataExportJob, error)
	Download(context.Context, string, string) ([]byte, error)
}
