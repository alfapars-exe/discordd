// music-worker opens only outbound TLS connections; it has no listening port.
package main

import (
	"context"
	"errors"
	"io"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/argeinfina/hichat/musicworker"
	"github.com/argeinfina/hichat/services"
)

func main() {
	if err := run(); err != nil {
		// Never log configuration paths, endpoint URLs, credentials or dependency
		// errors. The canonical code is sufficient for operational diagnosis.
		log.Print(services.MusicExecutorErrorLine(err))
		os.Exit(1)
	}
}

func run() error {
	token, err := readWorkerToken()
	if err != nil {
		return err
	}
	cookieFile := os.Getenv("HICHAT_MUSIC_WORKER_COOKIES_FILE")
	if cookieFile == "" || os.Getenv("HICHAT_MUSIC_WORKER_ENDPOINT") == "" {
		return &musicworker.Error{Code: "tool_missing"}
	}
	config := services.MusicWorkerRunnerConfig{
		YTDLPPath:  os.Getenv("HICHAT_MUSIC_WORKER_YTDLP_PATH"),
		CookieFile: cookieFile,
	}
	if config.JSEndpoint = os.Getenv("HICHAT_MUSIC_JS_ENDPOINT"); config.JSEndpoint != "" {
		config.JSToken, err = readPrivateTokenFile(os.Getenv("HICHAT_MUSIC_JS_TOKEN_FILE"))
		if err != nil {
			return err
		}
		config.JSExecPath = os.Getenv("HICHAT_MUSIC_JS_EXEC_PATH")
		if config.JSExecPath == "" {
			config.JSExecPath = "/usr/local/bin/hichat-js-exec"
		}
	} else if os.Getenv("HICHAT_MUSIC_JS_TOKEN_FILE") != "" || os.Getenv("HICHAT_MUSIC_JS_EXEC_PATH") != "" {
		return &musicworker.Error{Code: "tool_missing"}
	}
	runner, err := services.NewMusicWorkerRunner(config)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	log.Print("music worker process started")
	err = musicworker.RunWorker(ctx, musicworker.WorkerConfig{
		Endpoint: os.Getenv("HICHAT_MUSIC_WORKER_ENDPOINT"),
		Token:    token,
	}, func(jobCtx context.Context, request musicworker.Request, output io.Writer) error {
		operation := "unknown"
		switch request.Operation {
		case musicworker.OperationAudio, musicworker.OperationMetadata, musicworker.OperationSearch:
			operation = request.Operation
		}
		started := time.Now()
		log.Printf("music worker job started operation=%s", operation)
		jobErr := runner(jobCtx, request, output)
		result := "success"
		if jobErr != nil {
			result = strings.TrimPrefix(services.MusicExecutorErrorLine(jobErr), "ERROR: HICHAT_MUSIC_ERROR:")
			if errors.Is(jobErr, context.Canceled) {
				result = "canceled"
			}
		}
		log.Printf("music worker job finished operation=%s result=%s duration_ms=%d", operation, result, time.Since(started).Milliseconds())
		return jobErr
	})
	if errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}

func readWorkerToken() (string, error) {
	return readPrivateTokenFile(os.Getenv("HICHAT_MUSIC_WORKER_TOKEN_FILE"))
}

func readPrivateTokenFile(path string) (string, error) {
	invalid := &musicworker.Error{Code: "tool_missing"}
	if path == "" || !filepath.IsAbs(path) {
		return "", invalid
	}
	info, err := os.Lstat(path) // #nosec G703 -- absolute operator-configured local secret mount; no request can choose this path, and regular-file/private-mode/size checks below reject symlinks and public files
	if err != nil || !info.Mode().IsRegular() || info.Size() > 4096 || (runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0) {
		return "", invalid
	}
	file, err := os.Open(path) // #nosec G703 -- same operator-owned secret mount validated above; the deployed mount is read-only and request input never reaches this path
	if err != nil {
		return "", invalid
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 4097))
	if err != nil || len(data) > 4096 {
		return "", invalid
	}
	token := strings.TrimSpace(string(data))
	if len(token) < 32 || strings.ContainsAny(token, "\x00\r\n \t") {
		return "", invalid
	}
	return token, nil
}
