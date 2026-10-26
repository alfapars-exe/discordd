package services

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/argeinfina/hichat/musicjs"
	"github.com/argeinfina/hichat/musicworker"
)

// MusicWorkerRunnerConfig contains local operator configuration only. No path,
// executable or credential comes from a broker job.
type MusicWorkerRunnerConfig struct {
	YTDLPPath  string
	CookieFile string
	TempDir    string
	JSEndpoint string
	JSToken    string
	JSExecPath string
	// Tests can run the real process lifecycle without invoking a provider.
	command        func(context.Context, string, ...string) *exec.Cmd
	extractionGate chan struct{}
	jsClient       *musicjs.Client
}

// NewMusicWorkerRunner resolves the real pinned executable once. The remote
// helper resolver is intentionally not used here, preventing recursion.
func NewMusicWorkerRunner(config MusicWorkerRunnerConfig) (musicworker.Runner, error) {
	if config.YTDLPPath == "" {
		config.YTDLPPath = "yt-dlp"
	}
	bin, err := exec.LookPath(config.YTDLPPath)
	if err != nil || strings.Contains(strings.ToLower(filepath.Base(bin)), "hichat-media-exec") {
		return nil, &musicworker.Error{Code: "tool_missing"}
	}
	bin, err = filepath.Abs(bin)
	if err != nil {
		return nil, &musicworker.Error{Code: "tool_missing"}
	}
	if config.CookieFile != "" {
		if _, err := readMusicWorkerCookies(config.CookieFile); err != nil {
			return nil, err
		}
	}
	if config.JSEndpoint != "" {
		config.jsClient, err = musicjs.NewClient(config.JSEndpoint, config.JSToken)
		if err != nil {
			return nil, &musicworker.Error{Code: "tool_missing"}
		}
		if config.JSExecPath == "" {
			return nil, &musicworker.Error{Code: "tool_missing"}
		}
		config.JSExecPath, err = exec.LookPath(config.JSExecPath)
		if err != nil {
			return nil, &musicworker.Error{Code: "tool_missing"}
		}
		config.JSExecPath, err = filepath.Abs(config.JSExecPath)
		if err != nil {
			return nil, &musicworker.Error{Code: "tool_missing"}
		}
	} else if config.JSToken != "" || config.JSExecPath != "" {
		return nil, &musicworker.Error{Code: "tool_missing"}
	}
	// One provider startup at a time limits overlap between JavaScript solving
	// and metadata/search extraction. Streaming audio releases this slot as soon
	// as its first bytes arrive; the transport still enforces its job limits.
	config.extractionGate = make(chan struct{}, 1)
	return func(ctx context.Context, request musicworker.Request, output io.Writer) error {
		return runMusicWorkerJob(ctx, config, bin, request, output)
	}, nil
}

func runMusicWorkerJob(parent context.Context, config MusicWorkerRunnerConfig, bin string, request musicworker.Request, output io.Writer) error {
	if err := validateMusicWorkerRequest(request); err != nil {
		return err
	}
	timeout := 30 * time.Second
	switch request.Operation {
	case musicworker.OperationSearch:
		timeout = 20 * time.Second
	case musicworker.OperationAudio:
		timeout = 12 * time.Hour
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	if request.Operation != musicworker.OperationSearch {
		if err := validateMusicURLNetwork(ctx, request.Input); err != nil {
			return &musicworker.Error{Code: "invalid_request"}
		}
	}
	// MkdirTemp creates its directory with mode 0700, before any cookie is copied.
	privateDir, err := os.MkdirTemp(config.TempDir, "hichat-media-")
	if err != nil {
		return &musicworker.Error{Code: "tool_missing"}
	}
	defer func() { _ = os.RemoveAll(privateDir) }()
	// Authenticated discovery is limited to a single video. Search and playlist
	// enumeration use the public index without cookies, so account-private
	// playlists and history cannot be surfaced to app users.
	authenticated := config.CookieFile != "" && request.Operation != musicworker.OperationSearch && musicWorkerSingleVideo(request.Input)
	if request.Operation == musicworker.OperationAudio && !musicWorkerSingleVideo(request.Input) {
		return &musicworker.Error{Code: "invalid_request"}
	}
	cookiePath := ""
	if authenticated {
		cookies, err := readMusicWorkerCookies(config.CookieFile)
		if err != nil {
			return err
		}
		cookiePath = filepath.Join(privateDir, "cookies.txt")
		if err := os.WriteFile(cookiePath, cookies, 0600); err != nil {
			return &musicworker.Error{Code: "tool_missing"}
		}
	}
	args := musicWorkerArgs(request, cookiePath)
	var jsBridge *musicjs.Bridge
	if config.jsClient != nil {
		jsBridge, err = musicjs.StartBridge(ctx, privateDir, config.jsClient)
		if err != nil {
			return computeMusicWorkerError(err)
		}
		defer jsBridge.Close()
		for i := range args {
			if args[i] == "--js-runtimes" && i+1 < len(args) {
				args[i+1] = "deno:" + config.JSExecPath
				break
			}
		}
	}
	command := config.command
	if command == nil {
		command = exec.CommandContext
	}
	releaseExtraction, err := acquireMusicWorkerExtraction(ctx, config.extractionGate)
	if err != nil {
		if errors.Is(parent.Err(), context.Canceled) {
			return context.Canceled
		}
		return &musicworker.Error{Code: "network"}
	}
	defer releaseExtraction()
	cmd := command(ctx, bin, args...) // #nosec G204 -- operator-resolved executable and fixed argv, guarded YouTube input after --; no shell
	cmd.Dir = privateDir
	cmd.Env = musicWorkerProcessEnv(privateDir)
	if jsBridge != nil {
		cmd.Env = append(cmd.Env, musicjs.SocketEnvironment+"="+jsBridge.Path)
	}
	cmd.WaitDelay = subprocessWaitDelay
	cleanup := configureMusicWorkerProcess(cmd)
	stderr := &musicWorkerDiagnostics{tail: newTailBuffer(ytDlpStderrTailBytes)}
	cmd.Stderr = stderr
	// io.Writer failures immediately cancel the process group. Waiting for the
	// pipe buffer to fill can leave a stopped/paused job's subprocess alive.
	counted := &musicWorkerOutput{writer: output, cancel: cancel, firstOutput: releaseExtraction}
	var metadata musicMetadataBuffer
	if request.Operation == musicworker.OperationAudio {
		cmd.Stdout = counted
	} else {
		cmd.Stdout = &musicWorkerOutput{writer: &metadata, cancel: cancel}
	}
	err = cmd.Run()
	// Reap descendant processes immediately, before any downstream metadata
	// writer could block and leave the original process group behind.
	cleanup()
	if jsBridge != nil {
		jsBridge.Close()
	}
	releaseExtraction()
	stderr.finishLine()
	if ctx.Err() != nil {
		if errors.Is(parent.Err(), context.Canceled) {
			return context.Canceled
		}
		if metadata.overflow {
			return &musicworker.Error{Code: "output_limit"}
		}
		if counted.err != nil {
			return &musicworker.Error{Code: "network"}
		}
		return &musicworker.Error{Code: "network"}
	}
	if metadata.overflow {
		return &musicworker.Error{Code: "output_limit"}
	}
	// --ignore-errors and --ignore-no-formats-error can produce metadata despite
	// a provider refusal. Authentication/availability denials always take
	// precedence, even on exit zero; raw stderr never enters the result.
	if stderr.denied != "" {
		return &musicworker.Error{Code: string(stderr.denied)}
	}
	if jsBridge != nil {
		if err := jsBridge.Failure(); err != nil {
			return computeMusicWorkerError(err)
		}
	}
	if stderr.computeFailure != "" {
		return computeMusicWorkerError(&musicjs.Error{Code: stderr.computeFailure})
	}
	if stderr.runtimeFailed {
		return &musicworker.Error{Code: "tool_missing"}
	}
	if request.Operation != musicworker.OperationAudio {
		allowNoFormats := request.Operation == musicworker.OperationMetadata && musicWorkerSingleVideo(request.Input)
		if stderr.fatal || (stderr.noFormats && !allowNoFormats) || (err != nil && !(allowNoFormats && stderr.noFormats)) {
			return &musicworker.Error{Code: string(classifyPlaybackFailure(err, stderr.tail.String()))}
		}
		filtered, filterErr := filterMusicWorkerMetadata(metadata.buf.Bytes(), authenticated)
		if filterErr != nil {
			return filterErr
		}
		if len(filtered) > 0 {
			n, writeErr := output.Write(filtered)
			if writeErr == nil && n != len(filtered) {
				writeErr = io.ErrShortWrite
			}
			return writeErr
		}
	} else if err == nil && counted.written > 0 {
		return nil
	}
	if err == nil {
		return &musicworker.Error{Code: "unavailable"}
	}
	return &musicworker.Error{Code: string(classifyPlaybackFailure(err, stderr.tail.String()))}
}

// Compute service failures are never presented as YouTube 403/429 denials.
func computeMusicWorkerError(err error) error {
	switch musicjs.ErrorCode(err) {
	case "network", "timeout", "busy", "unavailable":
		return &musicworker.Error{Code: "network"}
	default:
		return &musicworker.Error{Code: "tool_missing"}
	}
}

func acquireMusicWorkerExtraction(ctx context.Context, gate chan struct{}) (func(), error) {
	if gate == nil {
		return func() {}, ctx.Err()
	}
	select {
	case gate <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	var once sync.Once
	release := func() { once.Do(func() { <-gate }) }
	if err := ctx.Err(); err != nil {
		release()
		return nil, err
	}
	return release, nil
}

type musicWorkerOutput struct {
	writer      io.Writer
	cancel      context.CancelFunc
	written     int64
	err         error
	firstOutput func()
}

func (w *musicWorkerOutput) Write(data []byte) (int, error) {
	// This marks available provider bytes, not successful/audible playback.
	// Release before the downstream Write, which may be intentionally paused.
	if len(data) > 0 && w.firstOutput != nil {
		w.firstOutput()
	}
	n, err := w.writer.Write(data)
	if err == nil && n != len(data) {
		err = io.ErrShortWrite
	}
	w.written += int64(n)
	if err != nil {
		w.err = err
		w.cancel()
	}
	return n, err
}

func musicWorkerArgs(request musicworker.Request, cookiePath string) []string {
	var args []string
	switch request.Operation {
	case musicworker.OperationSearch:
		args = searchMusicArgs(request.Input)
	case musicworker.OperationMetadata:
		args = extractTracksArgs(request.Input)
	case musicworker.OperationAudio:
		args = playTrackYtdlpArgs(request.Input, time.Duration(request.SeekSeconds)*time.Second)
	}
	// Insert operator flags before the end-of-options marker. Match-filter is
	// evaluated before printing/downloading by pinned yt-dlp; missing availability
	// fails this equality filter. Full metadata is necessary for that decision.
	extra := []string{"--no-cache-dir", "--no-color", "--quiet", "--socket-timeout", "10", "--extractor-retries", "1", "--retries", "1", "--fragment-retries", "1", "--no-js-runtimes", "--js-runtimes", "deno"}
	if request.Operation == musicworker.OperationMetadata && musicWorkerSingleVideo(request.Input) {
		// Metadata needs no signed media URL. Avoid solving the same JavaScript
		// challenge once here and again when the audio job starts.
		extra = append(extra, "--extractor-args", "youtube:player_skip=js", "--ignore-no-formats-error")
	}
	if cookiePath != "" {
		extra = append(extra, "--cookies", cookiePath, "--no-flat-playlist", "--match-filters", "availability=public")
	}
	if request.Operation == musicworker.OperationAudio {
		// Public-only is also enforced when no account cookies are configured.
		if cookiePath == "" {
			extra = append(extra, "--match-filters", "availability=public")
		}
	} else if cookiePath != "" {
		for i := range args {
			if args[i] == "%(.{id,title,uploader,channel,duration,thumbnail})j" {
				args[i] = "%(.{id,title,uploader,channel,duration,thumbnail,availability})j"
			}
		}
	}
	index := len(args) - 2
	return append(append(append([]string{}, args[:index]...), extra...), args[index:]...)
}

func musicWorkerSingleVideo(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	if youtubeVideoID.MatchString(u.Query().Get("v")) && strings.TrimSuffix(u.Path, "/") == "/watch" {
		return true
	}
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	if host == "youtu.be" || host == "www.youtu.be" {
		return youtubeVideoID.MatchString(strings.Trim(u.Path, "/"))
	}
	for _, prefix := range []string{"/shorts/", "/embed/", "/live/", "/v/"} {
		if strings.HasPrefix(u.Path, prefix) {
			return youtubeVideoID.MatchString(strings.TrimSuffix(strings.TrimPrefix(u.Path, prefix), "/"))
		}
	}
	return false
}

func filterMusicWorkerMetadata(data []byte, requirePublic bool) ([]byte, error) {
	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(make([]byte, 4096), 256<<10)
	var result bytes.Buffer
	encoder := json.NewEncoder(&result)
	for scanner.Scan() {
		var entry struct {
			ytdlpEntry
			Availability string `json:"availability"`
		}
		if json.Unmarshal(scanner.Bytes(), &entry) != nil || !youtubeVideoID.MatchString(entry.ID) {
			continue
		}
		if requirePublic && entry.Availability != "public" {
			continue
		}
		// Re-encoding a small allow-list prevents any extra provider output or
		// credential/header fields from entering the control channel.
		public := struct {
			ID       string  `json:"id"`
			Title    string  `json:"title"`
			Uploader string  `json:"uploader"`
			Channel  string  `json:"channel"`
			Duration float64 `json:"duration"`
		}{entry.ID, truncateRunes(entry.Title, 300), truncateRunes(entry.Uploader, 200), truncateRunes(entry.Channel, 200), entry.Duration}
		if encoder.Encode(public) != nil {
			return nil, &musicworker.Error{Code: "unknown"}
		}
	}
	if scanner.Err() != nil {
		return nil, &musicworker.Error{Code: "output_limit"}
	}
	return result.Bytes(), nil
}

// yt-dlp/deno/ffmpeg receive no worker token, application DB credentials or HF
// credentials. The job owns HOME/cache/tmp and only standard executable/runtime
// variables survive; yt-dlp configuration and plugin loading are disabled.
func musicWorkerProcessEnv(privateDir string) []string {
	env := []string{"HOME=" + privateDir, "XDG_CACHE_HOME=" + privateDir, "TMPDIR=" + privateDir, "TMP=" + privateDir, "TEMP=" + privateDir,
		"DENO_V8_FLAGS=--max-old-space-size=512,--max-semi-space-size=4"}
	for _, key := range []string{"PATH", "SystemRoot", "WINDIR", "PATHEXT", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR"} {
		if value, ok := os.LookupEnv(key); ok {
			env = append(env, key+"="+value)
		}
	}
	return env
}

// A bounded streaming classifier remembers provider denials even if subsequent
// warnings push the original line out of the diagnostic tail. exec.Cmd has one
// stderr copy goroutine; these fields are read only after Run has reaped it.
type musicWorkerDiagnostics struct {
	tail           *tailBuffer
	line           []byte
	denied         musicBotErrorReason
	runtimeFailed  bool
	fatal          bool
	noFormats      bool
	computeFailure string
}

func (d *musicWorkerDiagnostics) Write(data []byte) (int, error) {
	_, _ = d.tail.Write(data)
	for _, b := range data {
		if b == '\n' {
			d.finishLine()
			continue
		}
		d.line = append(d.line, b)
		if len(d.line) >= ytDlpStderrTailBytes {
			d.classifyLine(string(d.line))
			d.line = append(d.line[:0], d.line[len(d.line)-256:]...)
		}
	}
	return len(data), nil
}

func (d *musicWorkerDiagnostics) finishLine() {
	if len(d.line) > 0 {
		d.classifyLine(string(d.line))
		d.line = d.line[:0]
	}
}

func (d *musicWorkerDiagnostics) classifyLine(line string) {
	if code, ok := musicjs.DiagnosticCode(line); ok && d.computeFailure == "" {
		d.computeFailure = code
	}
	lower := strings.ToLower(strings.TrimSpace(line))
	if d.denied == "" {
		reason := classifyPlaybackFailure(nil, line)
		switch reason {
		case reasonBotCheck, reasonForbidden, reasonRateLimited, reasonAgeRestricted, reasonGeoBlocked:
			d.denied = reason
		}
		if d.denied == "" {
			for _, pattern := range []string{"video unavailable", "private video", "this video has been removed", "members-only", "members only", "subscriber-only", "subscriber only", "premium-only", "premium only"} {
				if strings.Contains(lower, pattern) {
					d.denied = reasonUnavailable
					break
				}
			}
		}
		if d.denied == "" {
			for _, pattern := range []string{"cookies are no longer valid", "cookies may no longer be valid", "cookies have expired", "cookies expired", "cookies are invalid", "invalid cookies", "invalid cookie", "cookie has expired", "failed to authenticate", "authentication failed", "login required"} {
				if strings.Contains(lower, pattern) {
					d.denied = reasonForbidden
					break
				}
			}
		}
	}
	for _, pattern := range []string{"javascript heap out of memory", "reached heap limit", "allocation failed - process out of memory", "fatal process out of memory", "fatal error: out of memory"} {
		if strings.Contains(lower, pattern) {
			d.runtimeFailed = true
			break
		}
	}
	if strings.HasPrefix(lower, "error:") {
		if strings.Contains(lower, "requested format is not available") || strings.Contains(lower, "no video formats found") || strings.Contains(lower, "no formats found") {
			d.noFormats = true
		} else {
			d.fatal = true
		}
	}
}
