package repository

import (
	"context"
	"github.com/argeinfina/hichat/models"
)

type MFARepository interface {
	Get(context.Context, string) (*models.MFARecord, error)
	ReserveAttempt(context.Context, string, int64) (bool, error)
	Prepare(context.Context, string, string, string, int64) (bool, error)
	CancelSetup(context.Context, string, string) (bool, error)
	Enable(context.Context, string, string, int64, int64, []string) (bool, error)
	ConsumeTOTP(context.Context, string, string, int64) (bool, error)
	ConsumeRecovery(context.Context, string, string, string) (bool, error)
	ReplaceRecovery(context.Context, string, string, int64, []string) (bool, error)
	Disable(context.Context, string, string) (bool, error)
}
