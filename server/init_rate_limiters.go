package main

import (
	"github.com/argeinfina/hichat/pkg/ratelimit"
	"time"
)

// initRateLimiters builds the limiter bundle after other services are assembled.
// Constructor dependencies keep allocation ownership explicit and testable.
func initRateLimiters(
	newLogin func(int, time.Duration) *ratelimit.LoginRateLimiter,
	newMessage func(int, time.Duration, time.Duration) *ratelimit.MessageRateLimiter,
) *RateLimiters {
	limiters := &RateLimiters{}
	// Rate limiters
	limiters.Login = newLogin(5, 2*time.Minute)
	// Chat messages: 10 per trailing 5s, sliding window, NO hard lockout
	// (cooldown=0). The previous 5/5s fixed window + 15s lockout was
	// trivially tripped by fast-but-normal typists — six quick lines cost a
	// hard 15-second freeze that users read as "sending is stuck". Channel
	// and DM budgets are separate instances so DM traffic can't starve
	// channel sends (or vice versa).
	limiters.Message = newMessage(10, 5*time.Second, 0)
	limiters.DMMessage = newMessage(10, 5*time.Second, 0)
	limiters.Register = newLogin(3, 10*time.Minute) // 3 registrations per 10 min per IP
	limiters.ForgotPwd = newLogin(3, 5*time.Minute) // 3 forgot-password per 5 min per IP
	limiters.ResetPwd = newLogin(5, 5*time.Minute)  // 5 reset attempts per 5 min per IP
	limiters.VerifyEmail = newLogin(10, 5*time.Minute)
	limiters.EmailUnsubscribe = newLogin(20, 5*time.Minute)
	limiters.Feedback = newMessage(2, 1*time.Minute, 30*time.Second) // 2 feedback per min, 30s cooldown
	// 30/min/IP: a normal client refreshes a ticket on reconnect (~1-3/min
	// even on flaky mobile networks); 30 is generous enough to absorb
	// reconnect storms while killing the brute-force / DoS scenario.
	limiters.WSTicket = newLogin(30, 1*time.Minute)

	// Uploads: 20 per minute per user, 30s cooldown once exceeded.
	// Sizing rationale: a photo drop of 10 files at once is fine
	// (nowhere near 20/min); a legit chat rarely posts even 5 uploads
	// per minute. 30s cooldown is short enough to not annoy legit users
	// but long enough to make a scripted spam cost noticeable.
	limiters.Upload = newMessage(20, 1*time.Minute, 30*time.Second)

	// DeviceEnum (P0-BD-02): the client fetches public device info / prekey
	// bundles lazily (one bundle per new conversation), so 30/min/IP sits far
	// above legitimate use while making bulk harvesting of the device-key
	// database impractical from a single source.
	limiters.DeviceEnum = newLogin(30, 1*time.Minute)

	// GroupSession (pentest C-03 follow-up finding 3): 20 per minute per
	// user, 30s cooldown once exceeded -- same shape as uploadLimiter above.
	limiters.GroupSession = newMessage(20, 1*time.Minute, 30*time.Second)

	// Refresh (security scan 2026-07-31, finding N-14): 30 per minute per IP,
	// same shape and rationale as wsTicketLimiter above -- refresh is called
	// on reconnect/near-expiry, not per keystroke.
	limiters.Refresh = newLogin(30, 1*time.Minute)

	// MusicPlay (resource scan 2026-08-02): 5 per minute per user, 30s
	// cooldown once exceeded -- see the RateLimiters.MusicPlay doc comment
	// above for the subprocess-cost rationale.
	limiters.MusicPlay = newMessage(5, 1*time.Minute, 30*time.Second)

	// SocialAction (Faz B, 2026-10-21): 20 per minute per user, 30s cooldown
	// once exceeded -- see the RateLimiters.SocialAction doc comment above.
	limiters.SocialAction = newMessage(20, 1*time.Minute, 30*time.Second)

	// CosmeticEquip (Faz G1): 10 per minute per user, 30s cooldown once
	// exceeded -- see the RateLimiters.CosmeticEquip doc comment above.
	limiters.CosmeticEquip = newMessage(10, 1*time.Minute, 30*time.Second)

	limiters.GameJoin = newLogin(60, time.Minute)

	return limiters
}
