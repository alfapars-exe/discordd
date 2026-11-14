package main

import (
	"github.com/argeinfina/hichat/config"
	"github.com/argeinfina/hichat/pkg/email"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
)

type accountSecurityHub interface {
	ws.EventPublisher
	services.AuthSessionDisconnecter
}
type accountSecurityEmail interface {
	email.EmailSender
	email.VerificationSender
}

type accountSecurityDependencies struct {
	Repositories    *Repositories
	Hub             accountSecurityHub
	Config          *config.Config
	Voice           services.VoiceDisconnecter
	Email           accountSecurityEmail
	Permissions     services.PermissionInvalidator
	UserCache       services.UserCacheInvalidator
	Logger          services.AuthAppLogger
	MusicRetirement services.MusicRequesterRetirementObserver
	EncryptionKey   []byte
}
type accountSecurityServices struct {
	Auth              services.AuthRuntime
	MFA               *services.MFAService
	EmailVerification *services.EmailVerificationService
}

// initAccountSecurityServices binds identity, session and account-security providers.
// Constructors do not start the separately owned maintenance workers.
func initAccountSecurityServices(deps accountSecurityDependencies) accountSecurityServices {
	for _, input := range []struct {
		name  string
		value any
	}{
		{"Repositories", deps.Repositories}, {"Hub", deps.Hub}, {"Config", deps.Config}, {"Voice", deps.Voice},
		{"Permissions", deps.Permissions}, {"UserCache", deps.UserCache}, {"Logger", deps.Logger}, {"MusicRetirement", deps.MusicRetirement},
	} {
		if missingCompositionInput(input.value) {
			panic("account security requires " + input.name)
		}
	}
	if deps.Email != nil && missingCompositionInput(deps.Email) {
		panic("account security email provider is typed nil")
	}
	repos, cfg := deps.Repositories, deps.Config
	mfa := services.NewMFAService(repos.MFA, repos.User, deps.EncryptionKey)
	verification := services.NewEmailVerificationService(repos.EmailVerification, deps.Email)
	auth := services.NewAuthService(repos.User, repos.Session, repos.ResetToken, deps.Hub, deps.Email, deps.Voice,
		cfg.JWT.Secret, cfg.JWT.AccessTokenExpiry, cfg.JWT.RefreshTokenExpiry,
		services.WithAuthSessionDisconnecter(deps.Hub), services.WithAuthOwnershipInvalidator(deps.Permissions),
		services.WithAuthUserCacheInvalidator(deps.UserCache), services.WithAuthAppLogger(deps.Logger), services.WithMFA(mfa),
		services.WithAuthSessions(repos.AuthSession), services.WithAccountLifecycle(repos.AccountLifecycle),
		services.WithAccountAnonymization(repos.AccountAnonymization, deps.MusicRetirement),
		services.WithApplicationRemoval(repos.ApplicationRemoval), services.WithServerOwnership(repos.ServerOwnership))
	return accountSecurityServices{Auth: auth, MFA: mfa, EmailVerification: verification}
}
