package services

import (
	"context"
	"errors"
	"testing"
	"time"

	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4/pkg/media"
)

type musicClockProbe struct {
	now       time.Time
	writes    []time.Time
	overshoot time.Duration
	writeCost time.Duration
	writeErr  error
}

func (p *musicClockProbe) WriteSample(media.Sample, *lksdk.SampleWriteOptions) error {
	p.writes = append(p.writes, p.now)
	p.now = p.now.Add(p.writeCost)
	return p.writeErr
}

func (p *musicClockProbe) controller(ctx context.Context) *musicSampleController {
	return &musicSampleController{ctx: ctx, bot: &botInstance{}, sink: p,
		now: func() time.Time { return p.now },
		wait: func(ctx context.Context, delay time.Duration) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			p.now = p.now.Add(delay + p.overshoot)
			return nil
		},
	}
}

func TestMusicClockDoesNotAccumulateTimerAndWriteOverhead(t *testing.T) {
	p := &musicClockProbe{now: time.Unix(100, 0), overshoot: time.Millisecond, writeCost: time.Millisecond}
	c := p.controller(context.Background())
	const frames = 3500
	for range frames {
		if err := c.WriteSample(media.Sample{Duration: 20 * time.Millisecond}, nil); err != nil {
			t.Fatal(err)
		}
	}
	span := p.writes[frames-1].Sub(p.writes[0])
	want := (frames - 1) * 20 * time.Millisecond
	if drift := span - want; drift < 0 || drift > time.Millisecond {
		t.Fatalf("70-second media clock drifted by %v (wall %v, media %v)", drift, span, want)
	}
	if c.bot.elapsed != frames*20*time.Millisecond {
		t.Fatalf("media elapsed changed: %v", c.bot.elapsed)
	}
}

func TestMusicClockRebasesAfterPauseTransportLossAndStall(t *testing.T) {
	for _, reason := range []string{"pause", "transport", "stall"} {
		t.Run(reason, func(t *testing.T) {
			p := &musicClockProbe{now: time.Unix(100, 0)}
			c := p.controller(context.Background())
			sample := media.Sample{Duration: 20 * time.Millisecond}
			if err := c.WriteSample(sample, nil); err != nil {
				t.Fatal(err)
			}
			ready := true
			c.ready = func() bool { return ready }
			if reason == "stall" {
				p.now = p.now.Add(500 * time.Millisecond)
			} else {
				c.bot.isPaused = reason == "pause"
				ready = reason != "transport"
				c.wait = func(context.Context, time.Duration) error {
					p.now = p.now.Add(time.Minute)
					c.bot.isPaused, ready = false, true
					c.wait = func(context.Context, time.Duration) error {
						p.now = p.now.Add(20 * time.Millisecond)
						return nil
					}
					return nil
				}
			}
			for range 4 {
				if err := c.WriteSample(sample, nil); err != nil {
					t.Fatal(err)
				}
			}
			for i := 2; i < len(p.writes); i++ {
				if gap := p.writes[i].Sub(p.writes[i-1]); gap < sample.Duration {
					t.Fatalf("%s caused a catch-up burst: %v", reason, gap)
				}
			}
		})
	}
}

func TestMusicClockOnlyCompensatesLessThanOneFrame(t *testing.T) {
	for _, late := range []time.Duration{19 * time.Millisecond, 20 * time.Millisecond, 500 * time.Millisecond} {
		p := &musicClockProbe{now: time.Unix(100, 0)}
		c := p.controller(context.Background())
		sample := media.Sample{Duration: 20 * time.Millisecond}
		_ = c.WriteSample(sample, nil)
		p.now = c.next.Add(late)
		_ = c.WriteSample(sample, nil)
		_ = c.WriteSample(sample, nil)
		_ = c.WriteSample(sample, nil)
		want := sample.Duration
		if late < sample.Duration {
			want -= late
		}
		if gap := p.writes[2].Sub(p.writes[1]); gap != want {
			t.Fatalf("lateness %v: next interval %v, want %v", late, gap, want)
		}
		if gap := p.writes[3].Sub(p.writes[2]); gap != sample.Duration {
			t.Fatalf("lateness %v: compensation exceeded one interval: %v", late, gap)
		}
	}
}

func TestMusicClockWriteFailureAndWaitCancellationDoNotAdvance(t *testing.T) {
	p := &musicClockProbe{now: time.Unix(100, 0), writeErr: errors.New("write rejected")}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := p.controller(ctx)
	sample := media.Sample{Duration: 20 * time.Millisecond}
	if err := c.WriteSample(sample, nil); !errors.Is(err, p.writeErr) {
		t.Fatalf("write failure lost: %v", err)
	}
	if !c.next.IsZero() || c.bot.elapsed != 0 || c.bot.startedAt != nil {
		t.Fatal("rejected write advanced the clock")
	}
	p.writeErr = nil
	if err := c.WriteSample(sample, nil); err != nil {
		t.Fatal(err)
	}
	next, elapsed, count := c.next, c.bot.elapsed, len(p.writes)
	c.wait = func(context.Context, time.Duration) error { cancel(); return ctx.Err() }
	if err := c.WriteSample(sample, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("wait cancellation lost: %v", err)
	}
	if c.next != next || c.bot.elapsed != elapsed || len(p.writes) != count {
		t.Fatal("cancelled wait advanced the clock")
	}
}
