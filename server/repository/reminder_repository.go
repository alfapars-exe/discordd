package repository

import (
	"context"
	"time"

	"github.com/argeinfina/hichat/models"
)

type ReminderRepository interface {
	Create(context.Context, *models.MessageReminder) error
	List(context.Context, string) ([]models.MessageReminder, error)
	GetByID(context.Context, string, string) (*models.MessageReminder, error)
	UpdateDue(context.Context, string, string, time.Time) (bool, error)
	Cancel(context.Context, string, string) (bool, error)
	// DeliverDue atomically changes each scheduled row and creates its system
	// notification in the same transaction. A crash can therefore neither
	// lose a claimed reminder nor produce the same reminder twice.
	DeliverDue(context.Context, time.Time, int) ([]models.Notification, error)
}
