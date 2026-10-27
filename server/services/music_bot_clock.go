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
	now     func() time.Time
	wait    func(context.Context, time.Duration) error
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
		now := c.clockNow()
		if paused || !ready {
			// Resume from the current time, never from a paused backlog.
			c.next = time.Time{}
		}
		delay := c.next.Sub(now)
		if !paused && ready && delay <= 0 {
			deadline := c.next
			// Keep ordinary timer/write overhead out of the media clock. A
			// whole missed frame starts a new schedule instead of a burst.
			if deadline.IsZero() || now.Sub(deadline) >= sample.Duration {
				deadline = now
			}
			// Serialize the write with Pause: once Pause returns no further
			// sample can escape until Resume. SDK WriteSample is a local RTP
			// write, not a request waiting for a remote peer's reply.
			err := c.sink.WriteSample(sample, opts)
			first := c.bot.startedAt == nil
			if err == nil {
				if first {
					c.bot.startedAt = &now
				}
				c.bot.elapsed += sample.Duration
				c.next = deadline.Add(sample.Duration)
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
		if err := c.waitFor(delay); err != nil {
			return err
		}
	}
}

func (c *musicSampleController) clockNow() time.Time {
	if c.now != nil {
		return c.now()
	}
	return time.Now()
}

func (c *musicSampleController) waitFor(delay time.Duration) error {
	if c.wait != nil {
		return c.wait(c.ctx, delay)
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-c.ctx.Done():
		return c.ctx.Err()
	case <-timer.C:
		return nil
	}
}
