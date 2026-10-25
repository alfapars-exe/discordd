// hichat-media-exec implements the server's fixed yt-dlp-shaped subprocess
// interface over its private local Unix socket. It never receives credentials.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/argeinfina/hichat/musicworker"
	"github.com/argeinfina/hichat/services"
)

func main() {
	if err := run(); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, services.MusicExecutorErrorLine(err))
		os.Exit(1)
	}
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	socket := os.Getenv("HICHAT_MUSIC_EXECUTOR_SOCKET")
	request, err := services.ParseMusicExecutorArgs(os.Args[1:])
	if err == nil && (socket == "" || !filepath.IsAbs(socket)) {
		err = &musicworker.Error{Code: "offline"}
	}
	if err == nil {
		err = musicworker.Execute(ctx, socket, request, os.Stdout)
	}
	return err
}
