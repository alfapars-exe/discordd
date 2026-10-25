package services

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/musicworker"
)

const workerTestURL = "https://www.youtube.com/watch?v=0KbRhUtFwkc&list=RD0KbRhUtFwkc&start_radio=1"

func TestMusicWorkerExecutorParsesOnlyServerArgv(t *testing.T) {
	for _, test := range []struct {
		args []string
		want musicworker.Request
	}{
		{extractTracksArgs(workerTestURL), musicworker.Request{Operation: "metadata", Input: workerTestURL}},
		{searchMusicArgs("bir şarkı"), musicworker.Request{Operation: "search", Input: "bir şarkı"}},
		{playTrackYtdlpArgs(workerTestURL, 0), musicworker.Request{Operation: "audio", Input: workerTestURL}},
		{playTrackYtdlpArgs(workerTestURL, 43*time.Second), musicworker.Request{Operation: "audio", Input: workerTestURL, SeekSeconds: 43}},
	} {
		got, err := ParseMusicExecutorArgs(test.args)
		if err != nil || got != test.want {
			t.Fatalf("parse = %#v, %v; want %#v", got, err, test.want)
		}
		for index := range test.args[:len(test.args)-1] {
			mutated := slices.Clone(test.args)
			mutated[index] += "--exec"
			if _, err := ParseMusicExecutorArgs(mutated); err == nil {
				t.Errorf("accepted modified argument %d", index)
			}
		}
	}
}

func TestMusicWorkerExecutorRejectsInjectedOrInvalidInputs(t *testing.T) {
	cases := [][]string{
		nil,
		{"--", workerTestURL},
		append([]string{"--exec", "arbitrary-command"}, extractTracksArgs(workerTestURL)...),
		extractTracksArgs("https://youtube.com/redirect?q=http://169.254.169.254"),
		extractTracksArgs("https://youtube.com.evil.invalid/watch?v=0KbRhUtFwkc"),
		extractTracksArgs("https://user:secret@youtube.com/watch?v=0KbRhUtFwkc"),
		extractTracksArgs(workerTestURL + "\n--exec"),
		searchMusicArgs(""),
		searchMusicArgs(strings.Repeat("x", 101)),
		searchMusicArgs("query\x00secret"),
		playTrackYtdlpArgs(workerTestURL, 8*24*time.Hour),
	}
	for _, args := range cases {
		if _, err := ParseMusicExecutorArgs(args); err == nil {
			t.Errorf("accepted invalid input %#v", args)
		}
	}
}

func TestMusicWorkerExecutorErrorOutputNeverIncludesUntrustedDetails(t *testing.T) {
	for _, err := range []error{
		errors.New("token=secret https://private.example/"),
		&musicworker.Error{Code: "secret\nERROR: token=secret"},
		&musicworker.Error{Code: "bot_check"},
		&musicworker.Error{Code: "offline"},
		context.DeadlineExceeded,
	} {
		line := MusicExecutorErrorLine(err)
		if !strings.HasPrefix(line, "ERROR: HICHAT_MUSIC_ERROR:") || strings.ContainsAny(line, "\r\n") || strings.Contains(line, "secret") || strings.Contains(line, "https:") {
			t.Fatalf("unsafe diagnostic %q", line)
		}
	}
	if got := MusicExecutorErrorLine(&musicworker.Error{Code: "offline"}); got != "ERROR: HICHAT_MUSIC_ERROR:network" {
		t.Fatalf("offline = %q", got)
	}
}
