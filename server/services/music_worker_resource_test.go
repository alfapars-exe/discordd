package services

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/argeinfina/hichat/musicworker"
)

func TestMusicWorkerResourceArgsAndEnvironmentAreFixed(t *testing.T) {
	t.Setenv("NODE_OPTIONS", "--require=/untrusted/secret.js --max-old-space-size=9000")
	t.Setenv("DENO_V8_FLAGS", "--max-old-space-size=9000,--allow-natives-syntax")
	for _, request := range []musicworker.Request{
		{Operation: musicworker.OperationMetadata, Input: workerTestURL},
		{Operation: musicworker.OperationMetadata, Input: "https://www.youtube.com/playlist?list=public"},
		{Operation: musicworker.OperationSearch, Input: "fixture search"},
		{Operation: musicworker.OperationAudio, Input: workerTestURL},
	} {
		args := musicWorkerArgs(request, "")
		assertHasAdjacentPair(t, args, "--js-runtimes", "deno")
		if !slices.Contains(args, "--no-js-runtimes") {
			t.Fatal("default JavaScript runtime was not disabled")
		}
		metadataOnly := request.Operation == musicworker.OperationMetadata && musicWorkerSingleVideo(request.Input)
		if slices.Contains(args, "--ignore-no-formats-error") != metadataOnly || slices.Contains(args, "--extractor-args") != metadataOnly {
			t.Fatal("metadata optimization escaped single-video metadata")
		}
		if metadataOnly {
			assertHasAdjacentPair(t, args, "--extractor-args", "youtube:player_skip=js")
		}
	}
	env := musicWorkerProcessEnv("/private/job")
	options := []string{}
	for _, entry := range env {
		if strings.HasPrefix(entry, "NODE_OPTIONS=") {
			t.Fatal("ambient Node options reached provider process")
		}
		if strings.HasPrefix(entry, "DENO_V8_FLAGS=") {
			options = append(options, entry)
		}
	}
	if !slices.Equal(options, []string{"DENO_V8_FLAGS=--max-old-space-size=512,--max-semi-space-size=4"}) {
		t.Fatal("ambient Deno flags escaped fixed resource limits")
	}
}

func resourceProviderCommand(ctx context.Context, mode string, extra ...string) *exec.Cmd {
	args := append([]string{"-test.run=^TestMusicWorkerResourceProviderFixture$", "--", mode}, extra...)
	return exec.CommandContext(ctx, os.Args[0], args...)
}

func TestMusicWorkerMetadataVetoesDenialsEvenWithDataAndExitZero(t *testing.T) {
	useMusicWorkerTestDNS(t)
	for _, tc := range []struct{ message, code string }{
		{"ERROR: Sign in to confirm you are not a bot", "bot_check"},
		{"ERROR: HTTP Error 403: Forbidden", "forbidden"},
		{"ERROR: HTTP Error 429: Too Many Requests", "rate_limited"},
		{"ERROR: Sign in to confirm your age", "age_restricted"},
		{"ERROR: The uploader has not made this video available in your country", "geo_blocked"},
		{"WARNING: The provided YouTube account cookies are no longer valid. They have likely been rotated", "forbidden"},
		{"WARNING: Authentication failed", "forbidden"},
		{"ERROR: Video unavailable", "unavailable"},
		{"ERROR: Private video", "unavailable"},
		{"ERROR: This is a members-only video", "unavailable"},
		{"FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory", "tool_missing"},
	} {
		t.Run(tc.code+"_"+tc.message[:5], func(t *testing.T) {
			config := MusicWorkerRunnerConfig{TempDir: t.TempDir(), command: func(ctx context.Context, _ string, _ ...string) *exec.Cmd {
				return resourceProviderCommand(ctx, "diagnostic", tc.message, "0")
			}}
			var output bytes.Buffer
			err := runMusicWorkerJob(context.Background(), config, os.Args[0], musicworker.Request{Operation: musicworker.OperationMetadata, Input: workerTestURL}, &output)
			var typed *musicworker.Error
			if !errors.As(err, &typed) || typed.Code != tc.code || output.Len() != 0 || strings.Contains(err.Error(), "fixture-secret") {
				t.Fatalf("provider denial was lost or data disclosed: %v bytes=%d", err, output.Len())
			}
		})
	}
}

func TestMusicWorkerMetadataOnlyIgnoresAbsentFormats(t *testing.T) {
	useMusicWorkerTestDNS(t)
	for _, tc := range []struct {
		name, message, input, operation string
		success                         bool
	}{
		{"single_video_no_formats", "ERROR: Requested format is not available", workerTestURL, musicworker.OperationMetadata, true},
		{"network_is_not_missing_formats", "ERROR: Connection reset by peer", workerTestURL, musicworker.OperationMetadata, false},
		{"search_does_not_ignore_formats", "ERROR: No video formats found", "fixture search", musicworker.OperationSearch, false},
		{"playlist_does_not_ignore_formats", "ERROR: No formats found", "https://www.youtube.com/playlist?list=public", musicworker.OperationMetadata, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			config := MusicWorkerRunnerConfig{TempDir: t.TempDir(), command: func(ctx context.Context, _ string, _ ...string) *exec.Cmd {
				return resourceProviderCommand(ctx, "diagnostic", tc.message, "1")
			}}
			var output bytes.Buffer
			err := runMusicWorkerJob(context.Background(), config, os.Args[0], musicworker.Request{Operation: tc.operation, Input: tc.input}, &output)
			if tc.success {
				if err != nil || !strings.Contains(output.String(), "public title") {
					t.Fatalf("public metadata lost: %v", err)
				}
			} else if err == nil || output.Len() != 0 {
				t.Fatalf("unrelated failure ignored: %v", err)
			}
		})
	}
}

type resourceBlockedOutput struct {
	ctx     context.Context
	entered chan struct{}
	once    sync.Once
}

func (w *resourceBlockedOutput) Write([]byte) (int, error) {
	w.once.Do(func() { close(w.entered) })
	<-w.ctx.Done()
	return 0, w.ctx.Err()
}

func awaitResourceSignal(t *testing.T, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(10 * time.Second):
		t.Fatal("resource phase not reached")
	}
}
func awaitResourceResult(t *testing.T, ch <-chan error) error {
	t.Helper()
	// These observations include startup/shutdown of a race-instrumented copy
	// of the entire services test binary. They do not alter provider deadlines.
	select {
	case err := <-ch:
		return err
	case <-time.After(10 * time.Second):
		t.Fatal("resource job did not finish")
		return nil
	}
}

func TestMusicWorkerExtractionGateReleasesBeforeBlockedFirstAudioWrite(t *testing.T) {
	useMusicWorkerTestDNS(t)
	audioStarting, allowAudio := make(chan struct{}), make(chan struct{})
	metadataStarting := make(chan struct{}, 1)
	runner, err := NewMusicWorkerRunner(MusicWorkerRunnerConfig{YTDLPPath: os.Args[0], TempDir: t.TempDir(), command: func(ctx context.Context, _ string, args ...string) *exec.Cmd {
		if slices.Contains(args, "-o") {
			close(audioStarting)
			select {
			case <-allowAudio:
			case <-ctx.Done():
			}
			return resourceProviderCommand(ctx, "audio-hold")
		}
		metadataStarting <- struct{}{}
		return resourceProviderCommand(ctx, "metadata")
	}})
	if err != nil {
		t.Fatal(err)
	}
	audioCtx, cancelAudio := context.WithCancel(context.Background())
	defer cancelAudio()
	blocked := &resourceBlockedOutput{ctx: audioCtx, entered: make(chan struct{})}
	audioDone := make(chan error, 1)
	go func() {
		audioDone <- runner(audioCtx, musicworker.Request{Operation: musicworker.OperationAudio, Input: workerTestURL}, blocked)
	}()
	awaitResourceSignal(t, audioStarting)
	metadataDone := make(chan error, 1)
	go func() {
		metadataDone <- runner(context.Background(), musicworker.Request{Operation: musicworker.OperationSearch, Input: "fixture search"}, io.Discard)
	}()
	select {
	case <-metadataStarting:
		t.Fatal("search overlapped audio extraction")
	case <-time.After(40 * time.Millisecond):
	}
	close(allowAudio)
	awaitResourceSignal(t, blocked.entered)
	awaitResourceSignal(t, metadataStarting)
	if err := awaitResourceResult(t, metadataDone); err != nil {
		t.Fatal(err)
	}
	cancelAudio()
	if err := awaitResourceResult(t, audioDone); !errors.Is(err, context.Canceled) {
		t.Fatalf("audio did not cancel: %v", err)
	}
}

func TestMusicWorkerExtractionGateReleasesBeforeBlockedMetadataOutput(t *testing.T) {
	useMusicWorkerTestDNS(t)
	var firstCommand *exec.Cmd
	var commandCount atomic.Int32
	runner, err := NewMusicWorkerRunner(MusicWorkerRunnerConfig{YTDLPPath: os.Args[0], TempDir: t.TempDir(), command: func(ctx context.Context, _ string, _ ...string) *exec.Cmd {
		cmd := resourceProviderCommand(ctx, "metadata")
		if commandCount.Add(1) == 1 {
			firstCommand = cmd
		}
		return cmd
	}})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	blocked := &resourceBlockedOutput{ctx: ctx, entered: make(chan struct{})}
	done := make(chan error, 1)
	go func() {
		done <- runner(ctx, musicworker.Request{Operation: musicworker.OperationMetadata, Input: workerTestURL}, blocked)
	}()
	select {
	case <-blocked.entered:
	case err := <-done:
		t.Fatalf("metadata returned before reaching its blocked consumer: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("metadata did not reach its blocked consumer")
	}
	if firstCommand == nil || firstCommand.ProcessState == nil {
		t.Fatal("metadata output began before provider was reaped")
	}
	if err := runner(context.Background(), musicworker.Request{Operation: musicworker.OperationSearch, Input: "fixture search"}, io.Discard); err != nil {
		t.Fatal(err)
	}
	cancel()
	_ = awaitResourceResult(t, done)
}

func TestMusicWorkerExtractionGateQueuedCancellationAndRecovery(t *testing.T) {
	useMusicWorkerTestDNS(t)
	audioStarting := make(chan struct{})
	var commands atomic.Int32
	runner, err := NewMusicWorkerRunner(MusicWorkerRunnerConfig{YTDLPPath: os.Args[0], TempDir: t.TempDir(), command: func(ctx context.Context, _ string, args ...string) *exec.Cmd {
		commands.Add(1)
		if slices.Contains(args, "-o") {
			close(audioStarting)
			<-ctx.Done()
		}
		return resourceProviderCommand(ctx, "metadata")
	}})
	if err != nil {
		t.Fatal(err)
	}
	audioCtx, cancelAudio := context.WithCancel(context.Background())
	defer cancelAudio()
	audioDone := make(chan error, 1)
	go func() {
		audioDone <- runner(audioCtx, musicworker.Request{Operation: musicworker.OperationAudio, Input: workerTestURL}, io.Discard)
	}()
	awaitResourceSignal(t, audioStarting)
	queuedCtx, cancelQueued := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancelQueued()
	err = runner(queuedCtx, musicworker.Request{Operation: musicworker.OperationMetadata, Input: workerTestURL}, io.Discard)
	var typed *musicworker.Error
	if !errors.As(err, &typed) || typed.Code != "network" || commands.Load() != 1 {
		t.Fatalf("queued deadline started a process or lost classification: %v", err)
	}
	canceledCtx, cancelCanceled := context.WithCancel(context.Background())
	cancelCanceled()
	if err := runner(canceledCtx, musicworker.Request{Operation: musicworker.OperationSearch, Input: "fixture search"}, io.Discard); !errors.Is(err, context.Canceled) {
		t.Fatalf("queued cancel lost: %v", err)
	}
	cancelAudio()
	if err := awaitResourceResult(t, audioDone); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if err := runner(context.Background(), musicworker.Request{Operation: musicworker.OperationMetadata, Input: workerTestURL}, io.Discard); err != nil {
		t.Fatalf("gate leaked after cancellation: %v", err)
	}
}

func TestMusicWorkerExtractionGateRecoversFromStartFailure(t *testing.T) {
	useMusicWorkerTestDNS(t)
	var calls atomic.Int32
	runner, err := NewMusicWorkerRunner(MusicWorkerRunnerConfig{YTDLPPath: os.Args[0], TempDir: t.TempDir(), command: func(ctx context.Context, _ string, _ ...string) *exec.Cmd {
		if calls.Add(1) == 1 {
			return exec.CommandContext(ctx, filepath.Join(t.TempDir(), "does-not-exist"))
		}
		return resourceProviderCommand(ctx, "metadata")
	}})
	if err != nil {
		t.Fatal(err)
	}
	request := musicworker.Request{Operation: musicworker.OperationMetadata, Input: workerTestURL}
	if err := runner(context.Background(), request, io.Discard); err == nil {
		t.Fatal("missing provider succeeded")
	}
	if err := runner(context.Background(), request, io.Discard); err != nil {
		t.Fatalf("start failure leaked gate: %v", err)
	}
}

func TestMusicWorkerResourceProviderFixture(t *testing.T) {
	boundary := slices.Index(os.Args, "--")
	if boundary < 0 || boundary+1 >= len(os.Args) {
		return
	}
	switch os.Args[boundary+1] {
	case "metadata":
		fmt.Fprintln(os.Stdout, `{"id":"0KbRhUtFwkc","title":"public title","availability":"public"}`)
	case "audio-hold":
		_, _ = os.Stdout.Write([]byte("audio"))
		time.Sleep(30 * time.Second)
	case "diagnostic":
		if boundary+3 >= len(os.Args) {
			os.Exit(2)
		}
		fmt.Fprintln(os.Stdout, `{"id":"0KbRhUtFwkc","title":"public title","availability":"public"}`)
		fmt.Fprintln(os.Stderr, os.Args[boundary+2]+" fixture-secret")
		// Force the initial refusal out of the retained 8 KiB tail. A later
		// benign format diagnostic must not turn the partial metadata into success.
		fmt.Fprintln(os.Stderr, strings.Repeat("benign diagnostic line\n", 800))
		if os.Args[boundary+3] == "1" {
			os.Exit(1)
		}
	}
	os.Exit(0)
}
