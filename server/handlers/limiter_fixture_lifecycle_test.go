package handlers

import (
	"github.com/argeinfina/hichat/testutil"
	"testing"
)

func TestHandlerLimiterFixturesReleaseTheirWorkers(t *testing.T) {
	for _, fixture := range []struct {
		name string
		run  func(*testing.T)
	}{
		{"TestBlockUser_RateLimit", TestBlockUser_RateLimit},
		{"TestCosmeticHandler_RateLimited", TestCosmeticHandler_RateLimited},
		{"TestCreateGroupSession_RateLimited", TestCreateGroupSession_RateLimited},
		{"TestEmailVerificationPublicProofLimits", TestEmailVerificationPublicProofLimits},
		{"TestEmojiHandler_CreateRateLimited", TestEmojiHandler_CreateRateLimited},
		{"TestEntranceHandler_Upload_RateLimited", TestEntranceHandler_Upload_RateLimited},
		{"TestCloneHandler_RateLimited", TestCloneHandler_RateLimited},
		{"TestSendRequest_RateLimit", TestSendRequest_RateLimit},
		{"TestPlay_RateLimit", TestPlay_RateLimit},
		{"TestStickerHandler_CreateRateLimited", TestStickerHandler_CreateRateLimited},
		{"TestGroupAccountMismatchPrecedesBodyServiceAndLimiter", TestGroupAccountMismatchPrecedesBodyServiceAndLimiter},
		{"TestGroupAddMemberAccountMismatchDoesNotConsumeLimiterAndQueryIsOptional", TestGroupAddMemberAccountMismatchDoesNotConsumeLimiterAndQueryIsOptional},
	} {
		t.Run(fixture.name, func(t *testing.T) { testutil.AssertLimiterFixtureCleanup(t, fixture.run) })
	}
}
