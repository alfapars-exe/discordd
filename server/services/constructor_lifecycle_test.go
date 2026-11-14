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
