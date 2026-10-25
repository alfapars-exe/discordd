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
	"time"

	"github.com/argeinfina/hichat/musicworker"
)

// MusicWorkerRunnerConfig contains local operator configuration only. No path,
// executable or credential comes from a broker job.
type MusicWorkerRunnerConfig struct {
	YTDLPPath  string
	CookieFile string
	TempDir    string
	// Tests can run the real process lifecycle without invoking a provider.
	command func(context.Context, string, ...string) *exec.Cmd
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
	command := config.command
	if command == nil {
		command = exec.CommandContext
	}
	cmd := command(ctx, bin, args...) // #nosec G204 -- operator-resolved executable and fixed argv, guarded YouTube input after --; no shell
	cmd.Dir = privateDir
	cmd.Env = musicWorkerProcessEnv(privateDir)
	cmd.WaitDelay = subprocessWaitDelay
	cleanup := configureMusicWorkerProcess(cmd)
	stderr := newTailBuffer(ytDlpStderrTailBytes)
	cmd.Stderr = stderr
	// io.Writer failures immediately cancel the process group. Waiting for the
	// pipe buffer to fill can leave a stopped/paused job's subprocess alive.
	counted := &musicWorkerOutput{writer: output, cancel: cancel}
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
	if request.Operation != musicworker.OperationAudio {
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
	return &musicworker.Error{Code: string(classifyPlaybackFailure(err, stderr.String()))}
}

type musicWorkerOutput struct {
	writer  io.Writer
	cancel  context.CancelFunc
	written int64
	err     error
}

func (w *musicWorkerOutput) Write(data []byte) (int, error) {
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
	extra := []string{"--no-cache-dir", "--no-color", "--quiet", "--socket-timeout", "10", "--extractor-retries", "1", "--retries", "1", "--fragment-retries", "1"}
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
	env := []string{"HOME=" + privateDir, "XDG_CACHE_HOME=" + privateDir, "TMPDIR=" + privateDir, "TMP=" + privateDir, "TEMP=" + privateDir}
	for _, key := range []string{"PATH", "SystemRoot", "WINDIR", "PATHEXT", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR"} {
		if value, ok := os.LookupEnv(key); ok {
			env = append(env, key+"="+value)
		}
	}
	return env
}
