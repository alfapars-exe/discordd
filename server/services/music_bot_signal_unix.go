//go:build !windows

package services

import "syscall"

// pauseProcess / resumeProcess — Unix-only SIGSTOP / SIGCONT delivery.
// HF Space and self-hosted backends both run Linux containers, so this is
// the production path. The Windows stub is in music_bot_signal_windows.go
// and returns an error so /pause and /resume cleanly degrade on the rare
// developer-on-Windows backend run.
func pauseProcess(pid int) error {
	return syscall.Kill(pid, syscall.SIGSTOP)
}

func resumeProcess(pid int) error {
	return syscall.Kill(pid, syscall.SIGCONT)
}
