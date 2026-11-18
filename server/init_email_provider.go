package main

import (
	"github.com/argeinfina/hichat/config"
	"github.com/argeinfina/hichat/pkg/email"
)

// configuredEmailProvider keeps incomplete optional configuration disabled.
// The complete provider contract prevents silently missing delivery features.
func configuredEmailProvider(cfg config.EmailConfig) email.Provider {
	if cfg.ResendAPIKey == "" || cfg.FromEmail == "" || cfg.AppURL == "" {
		bootLogger.Info("email service disabled (RESEND_API_KEY, RESEND_FROM or APP_URL not set)")
		return nil
	}
	provider := email.NewResendSender(cfg.ResendAPIKey, cfg.FromEmail, cfg.AppURL)
	bootLogger.Info("email service enabled", "from", cfg.FromEmail)
	return provider
}
