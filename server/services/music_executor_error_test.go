package services

import (
	"errors"
	"testing"
)

func TestRemoteExecutorErrorClassification(t *testing.T) {
	for _, reason := range []musicBotErrorReason{
		reasonForbidden, reasonBotCheck, reasonUnavailable, reasonAgeRestricted,
		reasonGeoBlocked, reasonRateLimited, reasonNetwork, reasonStalled,
		reasonToolMissing, reasonUnknown,
	} {
		t.Run(string(reason), func(t *testing.T) {
			err := errors.New("subprocess exit status 1")
			tail := "WARNING: unable to download webpage\nERROR: HICHAT_MUSIC_ERROR:" + string(reason) + "\n"
			if got := classifyPlaybackFailure(err, tail); got != reason {
				t.Fatalf("reason = %q, want %q", got, reason)
			}
		})
	}
	for _, tail := range []string{
		"ERROR: HICHAT_MUSIC_ERROR:tool_missing extra",
		"ERROR: HICHAT_MUSIC_ERROR:other",
		"ERROR: HICHAT_MUSIC_ERROR:tool_missing\nERROR: another failure",
	} {
		if got := classifyPlaybackFailure(errors.New("exit"), tail); got != reasonUnknown {
			t.Fatalf("untrusted marker %q classified as %q", tail, got)
		}
	}
	if got := classifyPlaybackFailure(errPlaybackStalled, "ERROR: HICHAT_MUSIC_ERROR:network"); got != reasonStalled {
		t.Fatalf("sentinel lost precedence: %q", got)
	}
}
