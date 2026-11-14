package ws

import (
	"context"
	"reflect"
	"testing"

	"github.com/argeinfina/hichat/models"
)

func TestHubDeclaresValidatedRuntimeComposition(t *testing.T) {
	if _, ok := reflect.TypeFor[*Hub]().MethodByName("ConfigureRuntime"); !ok {
		t.Fatal("Hub runtime wiring has no validated composition boundary")
	}
}

type runtimeLoggerRecorder struct{ calls int }

func (r *runtimeLoggerRecorder) Log(context.Context, models.LogLevel, models.LogCategory, *string, *string, string, map[string]string) {
	r.calls++
}

type runtimeAuthorizerRecorder struct {
	allowed bool
	calls   int
}

func (r *runtimeAuthorizerRecorder) CanModerateVoiceTarget(VoiceModerationContext) bool {
	r.calls++
	return r.allowed
}

func TestHubRuntimeValidationIsAtomicAndDispatchesInstalledDependencies(t *testing.T) {
	h := NewHub()
	t.Cleanup(h.Shutdown)
	logger := &runtimeLoggerRecorder{}
	authorizer := &runtimeAuthorizerRecorder{}
	if err := h.ConfigureRuntime(RuntimeDependencies{AppLogger: logger, VoiceAdminAuthorizer: authorizer}); err != nil {
		t.Fatal(err)
	}
	for _, deps := range []RuntimeDependencies{{}, {AppLogger: &runtimeLoggerRecorder{}}, {VoiceAdminAuthorizer: &runtimeAuthorizerRecorder{allowed: true}}} {
		if err := h.ConfigureRuntime(deps); err == nil {
			t.Fatal("accepted missing required runtime dependency")
		}
		if h.authorizeVoiceModeration("actor", "target", "mute") {
			t.Fatal("invalid composition replaced installed authorizer")
		}
		h.logEvent(models.LogLevelInfo, models.LogCategoryAuth, nil, "runtime test", nil)
	}
	if authorizer.calls != 3 || logger.calls != 3 {
		t.Fatalf("dispatch calls authorizer=%d logger=%d", authorizer.calls, logger.calls)
	}
	authorizer.allowed = true
	if !h.authorizeVoiceModeration("actor", "target", "move") {
		t.Fatal("installed authorizer result lost")
	}
}

func TestHubRuntimeRejectsTypedNilBeforeReplacingDependencies(t *testing.T) {
	h := NewHub()
	t.Cleanup(h.Shutdown)
	logger := &runtimeLoggerRecorder{}
	authorizer := &runtimeAuthorizerRecorder{}
	if err := h.ConfigureRuntime(RuntimeDependencies{AppLogger: logger, VoiceAdminAuthorizer: authorizer}); err != nil {
		t.Fatal(err)
	}
	var missingLogger *runtimeLoggerRecorder
	var missingAuthorizer *runtimeAuthorizerRecorder
	for name, deps := range map[string]RuntimeDependencies{
		"logger":     {AppLogger: missingLogger, VoiceAdminAuthorizer: authorizer},
		"authorizer": {AppLogger: logger, VoiceAdminAuthorizer: missingAuthorizer},
	} {
		t.Run(name, func(t *testing.T) {
			if err := h.ConfigureRuntime(deps); err == nil {
				t.Fatal("accepted typed nil runtime dependency")
			}
			h.logEvent(models.LogLevelInfo, models.LogCategoryAuth, nil, "retained runtime", nil)
			if h.authorizeVoiceModeration("actor", "target", "mute") {
				t.Fatal("installed deny result lost")
			}
		})
	}
	if logger.calls != 2 || authorizer.calls != 2 {
		t.Fatal("invalid dependency changed active runtime")
	}
}
