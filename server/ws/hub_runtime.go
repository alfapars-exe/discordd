package ws

import (
	"errors"
	"reflect"
)

// RuntimeDependencies is bound after service construction and before Run or
// request dispatch. NewHub alone supports standalone use without integrations.
type RuntimeDependencies struct {
	AppLogger            AppLogger
	VoiceAdminAuthorizer VoiceAdminAuthorizer
}

// ConfigureRuntime validates the complete production runtime before publishing
// either dependency. It must only be called during startup, before Hub.Run.
func (h *Hub) ConfigureRuntime(deps RuntimeDependencies) error {
	if missingRuntimeDependency(deps.AppLogger) {
		return errors.New("hub runtime requires app logger")
	}
	if missingRuntimeDependency(deps.VoiceAdminAuthorizer) {
		return errors.New("hub runtime requires voice moderation authorizer")
	}
	h.appLogger = deps.AppLogger
	h.voiceAdminAuthz = deps.VoiceAdminAuthorizer
	return nil
}

// An interface containing a nil pointer is non-nil but cannot provide the
// required runtime integration. Check nil-capable implementations at startup.
func missingRuntimeDependency(value any) bool {
	if value == nil {
		return true
	}
	reflected := reflect.ValueOf(value)
	switch reflected.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return reflected.IsNil()
	default:
		return false
	}
}
