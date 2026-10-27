package repository

import (
	"context"
	"io"

	"github.com/argeinfina/hichat/models"
)

type DataExportRepository interface {
	Create(context.Context, *models.User) (*models.DataExportJob, error)
	Get(context.Context, string, string) (*models.DataExportJob, error)
	Download(context.Context, string, string) ([]byte, error)
	DownloadAttachments(context.Context, string, string) (io.ReadCloser, int64, error)
	PurgeExpired(context.Context) error
	StartPendingArchives(context.Context) error
	StopArchiveWorker(context.Context) error
}
