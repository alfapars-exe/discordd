package services

import (
	"reflect"
	"testing"
)

// Callers must be able to retain cleanup without runtime capability assertions.
// Inspect the declared result, rather than the current concrete implementation.
func TestResourceOwningConstructorsDeclareStop(t *testing.T) {
	stop := reflect.TypeFor[interface{ Stop() }]()
	for _, factory := range []struct {
		name string
		fn   any
	}{
		{"channel permissions", NewChannelPermissionService},
		{"websocket tickets", NewWSTicketService},
		{"link preview", NewLinkPreviewService},
		{"online friend notifier", NewOnlineFriendNotifier},
	} {
		t.Run(factory.name, func(t *testing.T) {
			result := reflect.TypeOf(factory.fn).Out(0)
			if !result.Implements(stop) {
				t.Fatalf("constructor result %s omits its required Stop ownership contract", result)
			}
		})
	}
}

func TestVoiceConstructorDeclaresAllShutdownOwners(t *testing.T) {
	required := reflect.TypeFor[interface {
		StopMaintenance()
		ShutdownUsageProducers()
		ShutdownVoiceSessions()
		ShutdownVoiceStateFanout()
	}]()
	result := reflect.TypeOf(NewVoiceService).Out(0)
	if !result.Implements(required) {
		t.Fatalf("voice constructor result %s omits required lifecycle owners", result)
	}
}
