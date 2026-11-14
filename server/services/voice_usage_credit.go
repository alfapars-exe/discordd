package services

import (
	"context"
	"github.com/argeinfina/hichat/repository"
)

// VoiceUsageCredit selects replay-safe recording or durable handoff explicitly.
// Nil retains the standalone additive adapter on LiveKitInstanceGetter.
type VoiceUsageCredit func(context.Context, string, string, int, int, int) error

type VoiceUsageHandoff interface {
	repository.VoiceUsageRecorder
	EnqueueVoiceUsage(context.Context, string, string, int, int, int) error
}

// NewDurableVoiceUsageCredit commits the pending identity before application.
// An enqueue or application failure never selects additive accounting.
func NewDurableVoiceUsageCredit(store VoiceUsageHandoff) VoiceUsageCredit {
	return func(ctx context.Context, id, instance string, year, month, seconds int) error {
		if err := store.EnqueueVoiceUsage(ctx, id, instance, year, month, seconds); err != nil {
			return err
		}
		return store.RecordVoiceUsage(ctx, id, instance, year, month, seconds)
	}
}
