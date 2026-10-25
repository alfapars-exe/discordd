//go:build !linux

package services

import "os/exec"

// The deployed worker runs on Linux with process-group cancellation. Other
// platforms retain CommandContext cancellation for local parser/unit tests.
func configureMusicWorkerProcess(cmd *exec.Cmd) func() {
	return func() {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
	}
}
