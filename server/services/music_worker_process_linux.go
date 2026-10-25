//go:build linux

package services

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

// yt-dlp may spawn deno or ffmpeg. A stopped job must terminate the complete
// process group, including a child that inherited a media pipe.
func configureMusicWorkerProcess(cmd *exec.Cmd) func() {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	kill := func() error {
		if cmd.Process == nil {
			return os.ErrProcessDone
		}
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
	cmd.Cancel = kill
	return func() { _ = kill() }
}
