package services

import (
	"context"
	"github.com/argeinfina/hichat/pkg"
	"time"
)

type PendingVoiceUsageApplier interface {
	ApplyNextVoiceUsage(context.Context) (bool, error)
}

// StartVoiceUsageDelivery owns recovery of durable pending usage until Stop.
// HTTP and WebSocket producers must drain before Stop and database shutdown.
func StartVoiceUsageDelivery(parent context.Context, service interface{ StartVoiceUsageDelivery(context.Context) func() }) func() {
	return service.StartVoiceUsageDelivery(parent)
}
func (s *voiceService) StartVoiceUsageDelivery(parent context.Context) func() {
	return startVoiceUsageDelivery(parent, s, time.Second)
}
func startVoiceUsageDelivery(parent context.Context, s *voiceService, interval time.Duration) func() {
	if s.usageRecovery == nil {
		return func() {}
	}
	s.usageWorker.startParent(parent, interval, s.deliverPendingVoiceUsage)
	return s.usageWorker.stop
}
func (s *voiceService) deliverPendingVoiceUsage(parent context.Context) {
	store := s.usageRecovery
	if store == nil {
		return
	}
	ctx, cancel := context.WithTimeout(parent, 10*time.Second)
	defer cancel()
	for i := 0; i < 32; i++ {
		if ctx.Err() != nil {
			return
		}
		applied, err := store.ApplyNextVoiceUsage(ctx)
		if err != nil {
			if ctx.Err() == nil {
				voiceLogger.Warn("pending usage application failed", "err", pkg.ErrText(err))
			}
			return
		}
		if !applied {
			return
		}
	}
}
