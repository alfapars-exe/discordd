package services

import (
	"context"
	"github.com/argeinfina/hichat/pkg"
	"time"
)

type pendingVoiceUsageApplier interface {
	ApplyNextVoiceUsage(context.Context) (bool, error)
}

// StartVoiceUsageDelivery owns recovery of durable pending usage until Stop.
// HTTP and WebSocket producers must drain before Stop and database shutdown.
func StartVoiceUsageDelivery(parent context.Context, service VoiceService) func() {
	return startVoiceUsageDelivery(parent, service, time.Second)
}
func startVoiceUsageDelivery(parent context.Context, service VoiceService, interval time.Duration) func() {
	s, ok := service.(*voiceService)
	if !ok {
		return func() { /* Alternate voice implementation owns no worker here. */ }
	}
	if _, ok = s.livekitGetter.(pendingVoiceUsageApplier); !ok {
		return func() { /* Legacy getter has no durable pending usage queue. */ }
	}
	s.usageWorker.startParent(parent, interval, s.deliverPendingVoiceUsage)
	return s.usageWorker.stop
}
func (s *voiceService) deliverPendingVoiceUsage(parent context.Context) {
	store, ok := s.livekitGetter.(pendingVoiceUsageApplier)
	if !ok {
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
