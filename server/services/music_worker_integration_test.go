//go:build linux

package services

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/argeinfina/hichat/musicworker"
)

// This test uses the actual helper executable, Unix HTTP socket, WebSocket
// broker/worker and runner subprocess lifecycle. Only the provider executable
// and DNS answer are fixtures; no YouTube request or real account is involved.
func TestMusicWorkerIntegrationHelperToProvider(t *testing.T) {
	if testing.Short() {
		t.Skip("compiled-helper integration")
	}
	useMusicWorkerTestDNS(t)
	bin := os.Getenv("HICHAT_MEDIA_EXEC_TEST_BINARY")
	if bin == "" {
		bin = filepath.Join(t.TempDir(), "hichat-media-exec")
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer cancel()
		build := exec.CommandContext(ctx, "go", "build", "-o", bin, "../cmd/hichat-media-exec")
		if output, err := build.CombinedOutput(); err != nil {
			t.Fatalf("build actual helper: %v\n%s", err, output)
		}
	}
	if info, err := os.Stat(bin); err != nil || !info.Mode().IsRegular() {
		t.Fatal("actual helper executable unavailable")
	}
	t.Setenv("HF_TOKEN", "fixture-hf-secret-must-not-reach-provider")
	t.Setenv("HICHAT_MUSIC_WORKER_TOKEN", "fixture-worker-secret-must-not-reach-provider")

	dir, err := os.MkdirTemp("", "hichat-worker-it-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	cookieFile := filepath.Join(dir, "source-cookies.txt")
	sourceCookies := workerTestCookies + ".google.com\tTRUE\t/\tTRUE\t2000000000\tSID\tfixture-google-cookie-must-stay-local\n"
	if err := os.WriteFile(cookieFile, []byte(sourceCookies), 0600); err != nil {
		t.Fatal(err)
	}

	var commandsMu sync.Mutex
	var commands []*exec.Cmd
	config := MusicWorkerRunnerConfig{
		YTDLPPath: os.Args[0], CookieFile: cookieFile, TempDir: dir,
		command: func(ctx context.Context, _ string, args ...string) *exec.Cmd {
			mode := "audio"
			input := args[len(args)-1]
			if slices.Contains(args, "--skip-download") {
				mode = "metadata"
			}
			if strings.HasPrefix(input, "ytsearch5:") {
				mode = "search"
			} else {
				u, _ := url.Parse(input)
				switch u.Query().Get("v") {
				case "private0001":
					mode += "-private"
				case "failCheck01":
					mode = "audio-failure"
				case "cancel00001":
					mode = "audio-hold"
				}
			}
			fixtureArgs := append([]string{"-test.run=^TestMusicWorkerIntegrationProviderFixture$", "--", mode}, args...)
			cmd := exec.CommandContext(ctx, os.Args[0], fixtureArgs...)
			commandsMu.Lock()
			commands = append(commands, cmd)
			commandsMu.Unlock()
			return cmd
		},
	}
	runner, err := NewMusicWorkerRunner(config)
	if err != nil {
		t.Fatal(err)
	}
	finished := make(chan struct{}, 32)
	observedRunner := func(ctx context.Context, request musicworker.Request, out io.Writer) error {
		defer func() { finished <- struct{}{} }()
		return runner(ctx, request, out)
	}
	const token = "fixture-integration-worker-token-0123456789"
	broker, err := musicworker.NewBroker(token)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc(musicworker.ControlPath, broker.ControlHandler)
	mux.HandleFunc(musicworker.JobPath, broker.JobHandler)
	publicServer := httptest.NewServer(mux)
	socket := filepath.Join(dir, "executor.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(socket, 0600); err != nil {
		t.Fatal(err)
	}
	privateServer := &http.Server{Handler: http.HandlerFunc(broker.ExecutorHandler), ReadHeaderTimeout: time.Second}
	privateDone := make(chan error, 1)
	go func() { privateDone <- privateServer.Serve(listener) }()
	workerCtx, cancelWorker := context.WithCancel(context.Background())
	workerDone := make(chan error, 1)
	go func() {
		workerDone <- musicworker.RunWorker(workerCtx, musicworker.WorkerConfig{Endpoint: publicServer.URL, Token: token, ReconnectDelay: 10 * time.Millisecond}, observedRunner)
	}()
	t.Cleanup(func() {
		cancelWorker()
		_ = broker.Close()
		_ = privateServer.Close()
		publicServer.Close()
		select {
		case <-workerDone:
		case <-time.After(3 * time.Second):
			t.Error("worker failed to terminate")
		}
		select {
		case <-privateDone:
		case <-time.After(time.Second):
			t.Error("private listener failed to terminate")
		}
	})

	// Await an actual successful fixture job instead of relying on a sleep to
	// guess when the asynchronous control handshake has completed.
	readyCtx, readyCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer readyCancel()
	for {
		err := musicworker.Execute(readyCtx, socket, musicworker.Request{Operation: musicworker.OperationSearch, Input: "fixture readiness"}, io.Discard)
		if err == nil {
			break
		}
		var typed *musicworker.Error
		if !errors.As(err, &typed) || typed.Code != "offline" {
			t.Fatalf("worker readiness: %v", err)
		}
		select {
		case <-readyCtx.Done():
			t.Fatal("worker did not connect")
		case <-time.After(10 * time.Millisecond):
		}
	}
	waitMusicIntegrationRunner(t, finished)

	runHelper := func(t *testing.T, args []string) ([]byte, string, error) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, bin, args...)
		cmd.Env = append(os.Environ(), "HICHAT_MUSIC_EXECUTOR_SOCKET="+socket)
		var stdout, stderr bytes.Buffer
		cmd.Stdout, cmd.Stderr = &stdout, &stderr
		err := cmd.Run()
		return stdout.Bytes(), stderr.String(), err
	}

	t.Run("authenticated_metadata_filters_private_and_extra_fields", func(t *testing.T) {
		out, stderr, err := runHelper(t, extractTracksArgs(workerTestURL))
		if err != nil || stderr != "" {
			t.Fatalf("helper failed: %v %s", err, stderr)
		}
		var entry map[string]any
		if json.Unmarshal(bytes.TrimSpace(out), &entry) != nil || entry["id"] != "0KbRhUtFwkc" || entry["title"] != "public fixture title" {
			t.Fatalf("unexpected metadata: %s", out)
		}
		for _, forbidden := range []string{"private", "unknown", "subscriber", "fixture-secret", "http_headers", "availability", "signed"} {
			if bytes.Contains(out, []byte(forbidden)) {
				t.Fatalf("metadata disclosed %q", forbidden)
			}
		}
		waitMusicIntegrationRunner(t, finished)
	})
	t.Run("search_uses_public_index_without_account", func(t *testing.T) {
		out, stderr, err := runHelper(t, searchMusicArgs("fixture search"))
		if err != nil || stderr != "" || !bytes.Contains(out, []byte("public fixture title")) {
			t.Fatalf("search failed: %v %s", err, stderr)
		}
		waitMusicIntegrationRunner(t, finished)
	})
	t.Run("audio_bytes_and_seek_reach_real_helper", func(t *testing.T) {
		out, stderr, err := runHelper(t, playTrackYtdlpArgs(workerTestURL, 43*time.Second))
		if err != nil || stderr != "" || !bytes.Equal(out, musicIntegrationAudioFixture()) {
			t.Fatalf("audio roundtrip failed: %v %s length=%d", err, stderr, len(out))
		}
		waitMusicIntegrationRunner(t, finished)
	})
	t.Run("account_private_metadata_and_audio_emit_nothing", func(t *testing.T) {
		privateURL := "https://www.youtube.com/watch?v=private0001"
		for _, args := range [][]string{extractTracksArgs(privateURL), playTrackYtdlpArgs(privateURL, 0)} {
			out, stderr, err := runHelper(t, args)
			if err == nil || len(out) != 0 || stderr != "ERROR: HICHAT_MUSIC_ERROR:unavailable\n" {
				t.Fatalf("private request leaked or wrong result: %v %q bytes=%d", err, stderr, len(out))
			}
			waitMusicIntegrationRunner(t, finished)
		}
	})
	t.Run("audio_terminal_error_survives_stream_trailer", func(t *testing.T) {
		out, stderr, err := runHelper(t, playTrackYtdlpArgs("https://www.youtube.com/watch?v=failCheck01", 0))
		if err == nil || !bytes.Equal(out, musicIntegrationAudioFixture()) || stderr != "ERROR: HICHAT_MUSIC_ERROR:bot_check\n" {
			t.Fatalf("trailer lost/classification leaked: %v %q bytes=%d", err, stderr, len(out))
		}
		waitMusicIntegrationRunner(t, finished)
	})
	t.Run("modified_argv_is_rejected_before_worker", func(t *testing.T) {
		commandsMu.Lock()
		before := len(commands)
		commandsMu.Unlock()
		out, stderr, err := runHelper(t, append([]string{"--exec", "not-an-executable-command"}, extractTracksArgs(workerTestURL)...))
		if err == nil || len(out) != 0 || stderr != "ERROR: HICHAT_MUSIC_ERROR:unknown\n" {
			t.Fatalf("modified argv accepted or unsafe: %v %q", err, stderr)
		}
		commandsMu.Lock()
		after := len(commands)
		commandsMu.Unlock()
		if after != before {
			t.Fatal("modified argv reached provider process")
		}
	})
	t.Run("helper_kill_reaps_active_remote_provider", func(t *testing.T) {
		cmd := exec.Command(bin, playTrackYtdlpArgs("https://www.youtube.com/watch?v=cancel00001", 0)...)
		cmd.Env = append(os.Environ(), "HICHAT_MUSIC_EXECUTOR_SOCKET="+socket)
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			t.Fatal(err)
		}
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			if cmd.ProcessState == nil {
				_ = cmd.Process.Kill()
				_ = cmd.Wait()
			}
		})
		firstBytes := make([]byte, 4)
		readDone := make(chan error, 1)
		go func() { _, err := io.ReadFull(stdout, firstBytes); readDone <- err }()
		select {
		case err := <-readDone:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("helper produced no streaming audio")
		}
		if err := cmd.Process.Kill(); err != nil {
			t.Fatal(err)
		}
		_ = cmd.Wait()
		waitMusicIntegrationRunner(t, finished)
		commandsMu.Lock()
		provider := commands[len(commands)-1]
		commandsMu.Unlock()
		if provider.ProcessState == nil || !provider.ProcessState.Exited() && provider.ProcessState.Sys() == nil {
			t.Fatal("provider process was not reaped")
		}
	})

	// Cookie copies and process working directories are ephemeral. The source
	// jar retains even the unrelated test entry; it is never rewritten by a job.
	saved, err := os.ReadFile(cookieFile)
	if err != nil || string(saved) != sourceCookies {
		t.Fatal("source cookie jar was modified")
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "hichat-media-") {
			t.Fatal("job directory/cookie copy retained")
		}
	}
}

func waitMusicIntegrationRunner(t *testing.T, finished <-chan struct{}) {
	t.Helper()
	select {
	case <-finished:
	case <-time.After(3 * time.Second):
		t.Fatal("remote provider did not finish/reap")
	}
}

func musicIntegrationAudioFixture() []byte {
	return bytes.Repeat([]byte{'O', 'g', 'g', 'S', 0, 1, 2, 3, 255, 128, 0}, 20000)
}

// Executed as the provider subprocess by the full integration above. Assertions
// inspect the actual worker-generated argv, private cookie copy and child env.
func TestMusicWorkerIntegrationProviderFixture(t *testing.T) {
	boundary := slices.Index(os.Args, "--")
	if boundary < 0 || boundary+2 >= len(os.Args) {
		return
	}
	mode := os.Args[boundary+1]
	args := os.Args[boundary+2:]
	fail := func(reason string) { fmt.Fprintln(os.Stderr, "fixture assertion: "+reason); os.Exit(42) }
	if len(args) < 2 || args[len(args)-2] != "--" {
		fail("argument boundary")
	}
	for _, key := range []string{"HF_TOKEN", "HICHAT_MUSIC_WORKER_TOKEN", "HICHAT_MUSIC_EXECUTOR_SOCKET"} {
		if os.Getenv(key) != "" {
			fail("inherited credential environment")
		}
	}
	if os.Getenv("DENO_V8_FLAGS") != "--max-old-space-size=512,--max-semi-space-size=4" || os.Getenv("NODE_OPTIONS") != "" {
		fail("Deno resource limit")
	}
	runtimeIndex := slices.Index(args, "--js-runtimes")
	if !slices.Contains(args, "--no-js-runtimes") || runtimeIndex < 0 || runtimeIndex+1 >= len(args) || args[runtimeIndex+1] != "deno" {
		fail("fixed Deno runtime")
	}
	metadataOnly := strings.HasPrefix(mode, "metadata")
	if slices.Contains(args, "--ignore-no-formats-error") != metadataOnly {
		fail("metadata-only optimization scope")
	}
	if metadataOnly {
		index := slices.Index(args, "--extractor-args")
		if index < 0 || index+1 >= len(args) || args[index+1] != "youtube:player_skip=js" {
			fail("metadata JavaScript skip")
		}
	}
	for _, flag := range []string{"--ignore-config", "--no-plugin-dirs", "--no-remote-components", "--no-cache-dir"} {
		if !slices.Contains(args, flag) {
			fail("missing isolation flag")
		}
	}
	cookieIndex := slices.Index(args, "--cookies")
	if mode == "search" {
		if cookieIndex >= 0 || slices.Contains(args, "--match-filters") {
			fail("search inherited account")
		}
	} else {
		if cookieIndex < 0 || cookieIndex+1 >= len(args) {
			fail("account cookie missing")
		}
		cookiePath := args[cookieIndex+1]
		info, err := os.Stat(cookiePath)
		if err != nil || info.Mode().Perm() != 0600 || filepath.Dir(cookiePath) != os.Getenv("HOME") {
			fail("cookie isolation")
		}
		cookie, err := os.ReadFile(cookiePath)
		if err != nil || !bytes.Contains(cookie, []byte("test-cookie-value")) || bytes.Contains(cookie, []byte("fixture-google-cookie")) {
			fail("cookie filtering")
		}
		index := slices.Index(args, "--match-filters")
		if index < 0 || index+1 >= len(args) || args[index+1] != "availability=public" {
			fail("public-only guard absent")
		}
	}
	switch mode {
	case "metadata", "search":
		fmt.Fprintln(os.Stdout, `{"id":"0KbRhUtFwkc","title":"public fixture title","availability":"public","duration":2,"http_headers":{"Cookie":"fixture-secret"},"url":"https://signed/fixture-secret"}`)
		if mode == "metadata" {
			fmt.Fprintln(os.Stdout, `{"id":"private0001","title":"private title","availability":"private"}`)
			fmt.Fprintln(os.Stdout, `{"id":"unknown0001","title":"unknown title"}`)
			fmt.Fprintln(os.Stdout, `{"id":"members0001","title":"subscriber title","availability":"subscriber_only"}`)
		}
	case "metadata-private":
		fmt.Fprintln(os.Stdout, `{"id":"private0001","title":"private title","availability":"private"}`)
	case "audio-private":
		// Model the pinned provider enforcing its availability match-filter.
	case "audio":
		index := slices.Index(args, "--download-sections")
		if index < 0 || index+1 >= len(args) || args[index+1] != "*43-inf" {
			fail("seek lost")
		}
		_, _ = os.Stdout.Write(musicIntegrationAudioFixture())
	case "audio-failure":
		_, _ = os.Stdout.Write(musicIntegrationAudioFixture())
		fmt.Fprintln(os.Stderr, "ERROR: Sign in to confirm you are not a bot. Cookie: fixture-secret https://signed/fixture-secret")
		os.Exit(1)
	case "audio-hold":
		_, _ = os.Stdout.Write(musicIntegrationAudioFixture())
		time.Sleep(30 * time.Second)
	default:
		fail("unexpected mode")
	}
	os.Exit(0)
}
