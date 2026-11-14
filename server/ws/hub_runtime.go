package ws

import "errors"

// RuntimeDependencies is bound after service construction and before Run or
// request dispatch. NewHub alone supports standalone use without integrations.
type RuntimeDependencies struct {
	AppLogger            AppLogger
	VoiceAdminAuthorizer VoiceAdminAuthorizer
}

// ConfigureRuntime validates the complete production runtime before publishing
// either dependency. It must only be called during startup, before Hub.Run.
func (h *Hub) ConfigureRuntime(deps RuntimeDependencies) error {
	if deps.AppLogger == nil {
		return errors.New("hub runtime requires app logger")
	}
	if deps.VoiceAdminAuthorizer == nil {
		return errors.New("hub runtime requires voice moderation authorizer")
	}
	h.appLogger = deps.AppLogger
	h.voiceAdminAuthz = deps.VoiceAdminAuthorizer
	return nil
}
