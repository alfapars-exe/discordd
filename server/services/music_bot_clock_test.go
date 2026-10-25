package services

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4/pkg/media"
)

type musicPacketRecorder struct {
	mu      sync.Mutex
	packets [][]byte
}

func (r *musicPacketRecorder) WriteSample(s media.Sample, _ *lksdk.SampleWriteOptions) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.packets = append(r.packets, append([]byte(nil), s.Data...))
	return nil
}

func TestMusicPumpSkipsHeadersAndRejectsEmptyAudio(t *testing.T) {
	tags := oggPage(0, 0, 1, []byte("OpusTags\x00\x00\x00\x00\x00\x00\x00\x00"))
	header := append(oggOpusHeadPage(), tags...)
	r := &musicPacketRecorder{}
	if err := pumpOggToTrack(bytes.NewReader(header), r, nil); err == nil {
		t.Fatal("header-only stream must fail")
	}
	audio := []byte{0xf8, 0xff, 0xfe}
	page := oggAudioPage(2, audio)
	stream := make([]byte, len(header), len(header)+len(page))
	copy(stream, header)
	stream = append(stream, page...)
	if err := pumpOggToTrack(bytes.NewReader(stream), r, nil); err != nil {
		t.Fatal(err)
	}
	if len(r.packets) != 1 || !bytes.Equal(r.packets[0], audio) {
		t.Fatalf("published nonaudio headers: %x", r.packets)
	}
}

func TestMusicPauseResumePacesAndFreezesElapsed(t *testing.T) {
	svc := newTestMusicBotService("ch", "srv")
	defer svc.StopAll()
	bot := svc.bots["ch"]
	r := &musicPacketRecorder{}
	c := &musicSampleController{ctx: context.Background(), bot: bot, sink: r}
	sample := media.Sample{Data: []byte{0xf8, 0xff, 0xfe}, Duration: 20 * time.Millisecond}
	if err := c.WriteSample(sample, nil); err != nil {
		t.Fatal(err)
	}
	if err := svc.Pause("ch"); err != nil {
		t.Fatal(err)
	}
	paused := svc.GetState("ch")
	if !paused.IsPaused || paused.ElapsedSeconds != .02 {
		t.Fatalf("paused state: %+v", paused)
	}
	done := make(chan error, 1)
	go func() { done <- c.WriteSample(sample, nil) }()
	select {
	case <-done:
		t.Fatal("audio escaped while paused")
	case <-time.After(60 * time.Millisecond):
	}
	if got := svc.GetState("ch").ElapsedSeconds; got != paused.ElapsedSeconds {
		t.Fatalf("pause advanced clock: %v", got)
	}
	if err := svc.Resume("ch"); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("resume left pump blocked")
	}
	start := time.Now()
	for range 3 {
		if err := c.WriteSample(sample, nil); err != nil {
			t.Fatal(err)
		}
	}
	if time.Since(start) < 50*time.Millisecond {
		t.Fatal("resume burst buffered audio")
	}
	if got := svc.GetState("ch").ElapsedSeconds; got != .1 {
		t.Fatalf("elapsed=%v", got)
	}
}

func TestMusicSkipCancelsPausedPump(t *testing.T) {
	svc := newTestMusicBotService("ch", "srv")
	defer svc.StopAll()
	bot := svc.bots["ch"]
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	bot.cancelFn = cancel
	if err := svc.Pause("ch"); err != nil {
		t.Fatal(err)
	}
	c := &musicSampleController{ctx: ctx, bot: bot, sink: &musicPacketRecorder{}}
	done := make(chan error, 1)
	go func() { done <- c.WriteSample(media.Sample{Duration: 20 * time.Millisecond}, nil) }()
	if err := svc.Skip("ch"); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("got %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("skip hung during pause")
	}
}

func TestMusicClockWaitsForTransportAndCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var ready atomic.Bool
	bot := &botInstance{}
	r := &musicPacketRecorder{}
	c := &musicSampleController{ctx: ctx, bot: bot, sink: r, ready: ready.Load}
	done := make(chan error, 1)
	go func() { done <- c.WriteSample(media.Sample{Duration: 20 * time.Millisecond}, nil) }()
	select {
	case <-done:
		t.Fatal("published before track bound")
	case <-time.After(40 * time.Millisecond):
	}
	bot.mu.Lock()
	if bot.startedAt != nil || bot.elapsed != 0 {
		t.Error("clock advanced before track bound")
	}
	bot.mu.Unlock()
	ready.Store(true)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("bound track did not resume")
	}
	ready.Store(false)
	go func() { done <- c.WriteSample(media.Sample{Duration: 20 * time.Millisecond}, nil) }()
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("disconnected pump ignores cancellation")
	}
}

func TestMusicNextTrackResetsPauseAndPlaybackClock(t *testing.T) {
	now := time.Now()
	bot := &botInstance{startedAt: &now, elapsed: time.Minute, isPaused: true, queue: []models.MusicTrack{{VideoID: "next"}}}
	svc := &musicBotService{}
	_, step := svc.nextTrack(bot)
	if step != loopPlay || bot.startedAt != nil || bot.elapsed != 0 || bot.isPaused {
		t.Fatalf("next track inherited old clock/pause: %+v", bot)
	}
}

func TestMusicFFmpegArgumentScope(t *testing.T) {
	args := playTrackFFmpegArgs()
	if re, input := slices.Index(args, "-re"), slices.Index(args, "-i"); re < 0 || re > input {
		t.Fatalf("-re must precede -i: %v", args)
	}
	assertHasAdjacentPair(t, args, "-frame_duration", "20")
	assertHasAdjacentPair(t, args, "-page_duration", "20000")
	args = playTrackYtdlpArgs("https://www.youtube.com/watch?v=BaW_jenozKc", 0)
	for _, flag := range []string{"--ignore-config", "--no-plugin-dirs", "--no-remote-components", "--no-playlist"} {
		if !slices.Contains(args, flag) {
			t.Fatalf("missing %s", flag)
		}
	}
}

// Opt-in, no YouTube or LiveKit needed: exercise the REAL production FFmpeg
// argv with generated WAV, then parse and validate the resulting audio packets.
func TestMusicFFmpegSmoke(t *testing.T) {
	if os.Getenv("MUSIC_FFMPEG_SMOKE") != "1" {
		t.Skip("set MUSIC_FFMPEG_SMOKE=1 with ffmpeg on PATH")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	wav, err := exec.CommandContext(ctx, "ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.5", "-f", "wav", "pipe:1").Output()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.CommandContext(ctx, "ffmpeg", playTrackFFmpegArgs()...)
	cmd.Stdin = bytes.NewReader(wav)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	r := &musicPacketRecorder{}
	pumpErr := pumpOggToTrack(stdout, r, nil)
	_, _ = io.Copy(io.Discard, stdout)
	if err := cmd.Wait(); err != nil {
		t.Fatalf("ffmpeg failed: %v %s", err, stderr.String())
	}
	if pumpErr != nil {
		t.Fatal(pumpErr)
	}
	if len(r.packets) < 25 || len(r.packets) > 27 {
		t.Fatalf("expected ~26 audio packets, got %d", len(r.packets))
	}
	for _, packet := range r.packets {
		if len(packet) == 0 || bytes.HasPrefix(packet, []byte("Opus")) {
			t.Fatalf("invalid audio: %x", packet)
		}
	}
	t.Logf("actual FFmpeg produced %d stereo Opus packets; headers not published", len(r.packets))
}
