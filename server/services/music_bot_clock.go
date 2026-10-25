package services

import (
	"context"
	"time"

	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4/pkg/media"
)

// musicSampleController owns the delivery clock, not the extraction clock.
// It applies bounded backpressure while paused on every OS. Cancellation is
// checked even while paused, so skip/stop cannot strand a blocked pump.
type musicSampleController struct {
	ctx     context.Context
	bot     *botInstance
	sink    sampleWriter
	onStart func()
	ready   func() bool
	next    time.Time
}

func (c *musicSampleController) WriteSample(sample media.Sample, opts *lksdk.SampleWriteOptions) error {
	for {
		if err := c.ctx.Err(); err != nil {
			return err
		}
		c.bot.mu.Lock()
		if c.bot.killRequestedLocked() {
			c.bot.mu.Unlock()
			return context.Canceled
		}
		paused := c.bot.isPaused
		ready := c.ready == nil || c.ready()
		delay := time.Until(c.next)
		if !paused && ready && delay <= 0 {
			// Serialize the write with Pause: once Pause returns no further
			// sample can escape until Resume. SDK WriteSample is a local RTP
			// write, not a request waiting for a remote peer's reply.
			err := c.sink.WriteSample(sample, opts)
			first := c.bot.startedAt == nil
			if err == nil {
				now := time.Now()
				if first {
					c.bot.startedAt = &now
				}
				c.bot.elapsed += sample.Duration
				c.next = now.Add(sample.Duration)
			}
			c.bot.mu.Unlock()
			if err == nil && first && c.onStart != nil {
				c.onStart()
			}
			return err
		}
		c.bot.mu.Unlock()
		if paused || !ready || delay > 20*time.Millisecond {
			delay = 20 * time.Millisecond
		}
		timer := time.NewTimer(delay)
		select {
		case <-c.ctx.Done():
			timer.Stop()
			return c.ctx.Err()
		case <-timer.C:
		}
	}
}
