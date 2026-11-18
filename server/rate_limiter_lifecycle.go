package main

import "github.com/argeinfina/hichat/pkg/ratelimit"

// Stop releases every limiter maintenance worker owned by this bundle.
// Request budgets remain valid while HTTP handlers finish draining.
func (r *RateLimiters) Stop() {
	if r == nil {
		return
	}
	for _, limiter := range []*ratelimit.LoginRateLimiter{
		r.Login, r.Register, r.ForgotPwd, r.ResetPwd, r.VerifyEmail,
		r.EmailUnsubscribe, r.WSTicket, r.DeviceEnum, r.Refresh, r.GameJoin,
	} {
		if limiter != nil {
			limiter.Stop()
		}
	}
	for _, limiter := range []*ratelimit.MessageRateLimiter{
		r.Message, r.DMMessage, r.Feedback, r.Upload, r.GroupSession,
		r.MusicPlay, r.SocialAction, r.CosmeticEquip,
	} {
		if limiter != nil {
			limiter.Stop()
		}
	}
}
