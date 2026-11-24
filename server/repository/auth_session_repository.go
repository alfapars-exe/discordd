package repository

import (
	"context"
	"github.com/argeinfina/hichat/models"
)

type AuthSessionRepository interface {
	Create(context.Context, *models.AuthSession) error
	CreateWithRefresh(context.Context, *models.AuthSession, *models.Session) error
	RotateRefresh(context.Context, *models.Session, *models.Session, *models.AuthSession, int64) (bool, error)
	GetActive(context.Context, string, string, int64) (*models.AuthSession, error)
	ListActive(context.Context, string, int64) ([]models.AuthSession, error)
	Revoke(context.Context, string, string, int64, ...string) (bool, error)
	RevokeOthers(context.Context, string, string, int64) ([]string, error)
	RevokeAll(context.Context, string, int64) error
	UpdatePasswordAndRevoke(context.Context, string, string, string, string, int64) error
}

// AuthSessionTouch is one last-active write for a session that was just read
// as live.
type AuthSessionTouch struct {
	UserID, SessionID string
	At                int64
}

// AuthSessionTouchScheduler takes a touch off the caller's path. It must not
// block, and reports whether the touch was accepted for a later write.
type AuthSessionTouchScheduler func(AuthSessionTouch) bool
