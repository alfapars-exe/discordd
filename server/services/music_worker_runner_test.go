package services

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/musicworker"
)

const workerTestCookies = "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2000000000\tSID\ttest-cookie-value\n"

func TestMusicWorkerCookiesOnlyCopyYouTubeAndFailClosed(t *testing.T) {
	input := workerTestCookies + ".google.com\tTRUE\t/\tTRUE\t2000000000\tSID\tgoogle-secret\n" +
		"#HttpOnly_www.youtube.com\tFALSE\t/\tTRUE\t2000000000\tHSID\thttp-only-value\n"
	got, err := filterMusicWorkerCookies([]byte(input))
	if err != nil || !bytes.Contains(got, []byte("http-only-value")) || bytes.Contains(got, []byte("google-secret")) {
		t.Fatalf("cookie filtering failed: %v", err)
	}
	for _, bad := range []string{"", "SID=secret", strings.Replace(workerTestCookies, "2000000000", "NaN", 1), strings.Replace(workerTestCookies, "test-cookie-value", "secret\x00value", 1)} {
		if _, err := filterMusicWorkerCookies([]byte(bad)); err == nil || strings.Contains(err.Error(), "secret") {
			t.Fatal("invalid cookie jar accepted or disclosed")
		}
	}
}

func TestMusicWorkerCookieFileMustBePrivateRegularAndBounded(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "cookies.txt")
	if err := os.WriteFile(path, []byte(workerTestCookies), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readMusicWorkerCookies(path); err != nil {
		t.Fatal(err)
	}
	if _, err := readMusicWorkerCookies(dir); err == nil {
		t.Fatal("accepted directory")
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(path, 0644); err != nil {
			t.Fatal(err)
		}
		if _, err := readMusicWorkerCookies(path); err == nil {
			t.Fatal("accepted public cookie file")
		}
		if err := os.Chmod(path, 0600); err != nil {
			t.Fatal(err)
		}
		link := filepath.Join(dir, "link")
		if err := os.Symlink(path, link); err != nil {
			t.Fatal(err)
		}
		if _, err := readMusicWorkerCookies(link); err == nil {
			t.Fatal("accepted symlink")
		}
	}
	if err := os.WriteFile(path, bytes.Repeat([]byte("x"), maxMusicWorkerCookieBytes+1), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readMusicWorkerCookies(path); err == nil {
		t.Fatal("accepted unbounded cookies")
	}
}

func TestMusicWorkerAuthenticatedArgsPublicOnlyBeforeOutput(t *testing.T) {
	for _, operation := range []string{"metadata", "audio"} {
		args := musicWorkerArgs(musicworker.Request{Operation: operation, Input: workerTestURL, SeekSeconds: map[bool]int64{true: 43}[operation == "audio"]}, "/private/cookies.txt")
		for _, pair := range [][2]string{{"--cookies", "/private/cookies.txt"}, {"--match-filters", "availability=public"}, {"--use-extractors", "Youtube.*"}} {
			assertHasAdjacentPair(t, args, pair[0], pair[1])
		}
		if !slices.Contains(args, "--no-flat-playlist") || args[len(args)-2] != "--" || args[len(args)-1] != workerTestURL {
			t.Fatal("account job lost public-only full extraction or argument boundary")
		}
		if operation == "audio" {
			assertHasAdjacentPair(t, args, "--download-sections", "*43-inf")
		}
	}
	if musicWorkerSingleVideo("https://www.youtube.com/playlist?list=private") || musicWorkerSingleVideo("https://www.youtube.com/watch?v=bad") {
		t.Fatal("private playlist or invalid ID treated as a single video")
	}
}

func TestMusicWorkerMetadataRejectsPrivateUnknownAndExtraFields(t *testing.T) {
	input := []byte(`{"id":"0KbRhUtFwkc","title":"public title","availability":"public","http_headers":{"Cookie":"private-secret"},"url":"https://signed/private-secret"}` + "\n" +
		`{"id":"abcdefghijk","title":"private title","availability":"private"}` + "\n" +
		`{"id":"abcdefghij0","title":"unknown title"}` + "\n" +
		`{"id":"abcdefghij1","title":"members title","availability":"subscriber_only"}` + "\n")
	got, err := filterMusicWorkerMetadata(input, true)
	if err != nil || !bytes.Contains(got, []byte("public title")) {
		t.Fatalf("public metadata lost: %v", err)
	}
	for _, bad := range []string{"private", "unknown", "members", "http_headers", "Cookie", "signed"} {
		if bytes.Contains(got, []byte(bad)) {
			t.Fatalf("account-only or extra data escaped: %q", bad)
		}
	}
}

func TestMusicWorkerChildEnvironmentOmitsCredentials(t *testing.T) {
	t.Setenv("HF_TOKEN", "hf-secret")
	t.Setenv("HICHAT_MUSIC_WORKER_TOKEN", "worker-secret")
	t.Setenv("HTTP_PROXY", "http://proxy-secret")
	env := strings.Join(musicWorkerProcessEnv("/private/job"), "\n")
	for _, secret := range []string{"hf-secret", "worker-secret", "proxy-secret", "HF_TOKEN", "HTTP_PROXY"} {
		if strings.Contains(env, secret) {
			t.Fatalf("child inherited %s", secret)
		}
	}
	if !strings.Contains(env, "HOME=/private/job") {
		t.Fatal("child HOME not isolated")
	}
}

func useMusicWorkerTestDNS(t *testing.T) {
	t.Helper()
	original := musicURLResolver
	musicURLResolver = stubIPResolver{ips: []net.IPAddr{{IP: net.ParseIP("142.250.185.78")}}}
	t.Cleanup(func() { musicURLResolver = original })
}

func workerHelperCommand(mode string, onCommand func(*exec.Cmd, []string)) func(context.Context, string, ...string) *exec.Cmd {
	return func(ctx context.Context, _ string, args ...string) *exec.Cmd {
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestMusicWorkerHelperProcess$", "--", mode)
		if onCommand != nil {
			onCommand(cmd, args)
		}
		return cmd
	}
}

func TestMusicWorkerRunnerKeepsSourceCookiesPrivateAndCleansJob(t *testing.T) {
	useMusicWorkerTestDNS(t)
	dir := t.TempDir()
	cookieFile := filepath.Join(dir, "source.txt")
	if err := os.WriteFile(cookieFile, []byte(workerTestCookies), 0600); err != nil {
		t.Fatal(err)
	}
	var captured []string
	config := MusicWorkerRunnerConfig{TempDir: dir, CookieFile: cookieFile, command: workerHelperCommand("metadata", func(_ *exec.Cmd, args []string) { captured = slices.Clone(args) })}
	var output bytes.Buffer
	err := runMusicWorkerJob(context.Background(), config, os.Args[0], musicworker.Request{Operation: "metadata", Input: workerTestURL}, &output)
	if err != nil || !strings.Contains(output.String(), "public title") {
		t.Fatalf("job failed: %v", err)
	}
	cookieIndex := slices.Index(captured, "--cookies")
	if cookieIndex < 0 || captured[cookieIndex+1] == cookieFile {
		t.Fatal("source jar passed to subprocess")
	}
	if _, err := os.Stat(captured[cookieIndex+1]); !os.IsNotExist(err) {
		t.Fatal("job cookie copy retained")
	}
	original, err := os.ReadFile(cookieFile)
	if err != nil || string(original) != workerTestCookies {
		t.Fatal("source cookie jar changed")
	}
}

func TestMusicWorkerRunnerPublicDiscoveryNeverUsesCookies(t *testing.T) {
	useMusicWorkerTestDNS(t)
	for _, request := range []musicworker.Request{{Operation: "search", Input: "a song"}, {Operation: "metadata", Input: "https://www.youtube.com/playlist?list=public"}} {
		config := MusicWorkerRunnerConfig{TempDir: t.TempDir(), CookieFile: "unreadable-must-not-be-opened", command: workerHelperCommand("metadata", func(_ *exec.Cmd, args []string) {
			if slices.Contains(args, "--cookies") {
				t.Error("account cookie used for discovery")
			}
		})}
		if err := runMusicWorkerJob(context.Background(), config, os.Args[0], request, io.Discard); err != nil {
			t.Fatal(err)
		}
	}
}

func TestMusicWorkerRunnerCancelsAndReapsProcess(t *testing.T) {
	useMusicWorkerTestDNS(t)
	ctx, cancel := context.WithCancel(context.Background())
	var command *exec.Cmd
	config := MusicWorkerRunnerConfig{TempDir: t.TempDir(), command: workerHelperCommand("sleep", func(cmd *exec.Cmd, _ []string) { command = cmd })}
	// The fake process announces that it has entered its streaming loop before
	// the receiver cancels, exercising cancellation of a live subprocess.
	writer := &musicWorkerCancelWriter{cancel: cancel}
	err := runMusicWorkerJob(ctx, config, os.Args[0], musicworker.Request{Operation: "audio", Input: workerTestURL}, writer)
	if !errors.Is(err, context.Canceled) || writer.canceledAt.IsZero() || time.Since(writer.canceledAt) > 3*time.Second || command == nil || command.ProcessState == nil {
		t.Fatalf("process not canceled/reaped promptly: %v", err)
	}
}

type musicWorkerCancelWriter struct {
	cancel     context.CancelFunc
	canceledAt time.Time
}

func (w *musicWorkerCancelWriter) Write(data []byte) (int, error) {
	w.canceledAt = time.Now()
	w.cancel()
	return len(data), nil
}

type musicWorkerRejectWriter struct{}

func (musicWorkerRejectWriter) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }

func TestMusicWorkerRunnerWriterFailureReapsProcessAndSanitizesErrors(t *testing.T) {
	useMusicWorkerTestDNS(t)
	for _, test := range []struct {
		mode, code string
		writer     io.Writer
	}{{"sleep", "network", musicWorkerRejectWriter{}}, {"failure", "bot_check", io.Discard}, {"overflow", "output_limit", io.Discard}} {
		var command *exec.Cmd
		config := MusicWorkerRunnerConfig{TempDir: t.TempDir(), command: workerHelperCommand(test.mode, func(cmd *exec.Cmd, _ []string) { command = cmd })}
		operation := "audio"
		if test.mode == "overflow" {
			operation = "metadata"
		}
		err := runMusicWorkerJob(context.Background(), config, os.Args[0], musicworker.Request{Operation: operation, Input: workerTestURL}, test.writer)
		var typed *musicworker.Error
		if !errors.As(err, &typed) || typed.Code != test.code || strings.Contains(err.Error(), "secret") || command.ProcessState == nil {
			t.Fatalf("%s: wrong or unsafe error %v", test.mode, err)
		}
	}
}

func TestMusicWorkerRunnerRejectsDNSBeforeProcess(t *testing.T) {
	original := musicURLResolver
	musicURLResolver = stubIPResolver{ips: []net.IPAddr{{IP: net.ParseIP("127.0.0.1")}}}
	t.Cleanup(func() { musicURLResolver = original })
	config := MusicWorkerRunnerConfig{command: func(context.Context, string, ...string) *exec.Cmd {
		t.Fatal("started process for private DNS")
		return nil
	}}
	if err := runMusicWorkerJob(context.Background(), config, os.Args[0], musicworker.Request{Operation: "audio", Input: workerTestURL}, io.Discard); err == nil {
		t.Fatal("accepted private DNS")
	}
}

func TestMusicWorkerHelperProcess(t *testing.T) {
	index := slices.Index(os.Args, "--")
	if index < 0 || index+1 >= len(os.Args) {
		return
	}
	switch os.Args[index+1] {
	case "metadata":
		fmt.Fprintln(os.Stdout, `{"id":"0KbRhUtFwkc","title":"public title","availability":"public"}`)
	case "sleep":
		_, _ = os.Stdout.Write([]byte("media"))
		time.Sleep(30 * time.Second)
	case "failure":
		fmt.Fprintln(os.Stderr, "ERROR: Sign in to confirm you are not a bot. Cookie: token=secret https://private.example/secret")
		os.Exit(1)
	case "overflow":
		_, _ = os.Stdout.Write(bytes.Repeat([]byte("x"), maxMusicMetadataBytes+1))
	}
	os.Exit(0)
}
