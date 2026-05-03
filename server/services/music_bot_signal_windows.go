//go:build windows

package services

import "errors"

// Windows lacks SIGSTOP/SIGCONT. SuspendThread on every ffmpeg thread is
// theoretically possible via undocumented APIs but fragile. Production
// deployments run Linux containers — leaving this stub keeps the build
// green on developer Windows machines without faking pause behaviour.
var errPauseUnsupported = errors.New("pause/resume not supported on Windows; deploy to Linux")

func pauseProcess(_ int) error  { return errPauseUnsupported }
func resumeProcess(_ int) error { return errPauseUnsupported }
