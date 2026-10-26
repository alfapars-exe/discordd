// hichat-js-exec implements only the pinned Deno interface used by yt-dlp EJS.
package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/argeinfina/hichat/musicjs"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	err := run(ctx, os.Args[1:], os.Stdin, os.Stdout, os.Getenv(musicjs.SocketEnvironment))
	stop()
	if err != nil {
		_, _ = fmt.Fprintln(os.Stderr, musicjs.Diagnostic(err))
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, input io.Reader, output io.Writer, socket string) error {
	if musicjs.IsVersionArgs(args) {
		_, err := io.WriteString(output, "deno 2.9.8\n")
		return err
	}
	if !musicjs.ValidRunArgs(args) {
		return &musicjs.Error{Code: "invalid_request"}
	}
	if socket == "" || !filepath.IsAbs(socket) {
		return &musicjs.Error{Code: "unavailable"}
	}
	envelope, err := io.ReadAll(io.LimitReader(input, int64(musicjs.MaxEnvelopeBytes)+1))
	if err != nil {
		return &musicjs.Error{Code: "invalid_request"}
	}
	payload, err := musicjs.ExtractRequest(envelope)
	if err != nil {
		return err
	}
	return musicjs.Execute(ctx, socket, payload, output)
}
