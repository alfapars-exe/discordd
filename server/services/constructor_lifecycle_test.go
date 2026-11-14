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

func TestAuthConstructorRequiresVoiceRevocationDependency(t *testing.T) {
	required := reflect.TypeFor[VoiceDisconnecter]()
	if got := reflect.TypeOf(NewAuthService).In(5); got != required {
		t.Fatalf("auth constructor dependency5=%s, want explicit %s", got, required)
	}
}

func TestServerConstructorRequiresMembershipVoiceCleanup(t *testing.T) {
	required := reflect.TypeFor[func(string, string)]()
	if got := reflect.TypeOf(NewServerService).In(14); got != required {
		t.Fatalf("server constructor dependency14=%s, want explicit %s", got, required)
	}
}

func TestFriendshipConstructorRequiresExplicitEmailQueue(t *testing.T) {
	required := reflect.TypeFor[EmailEnqueuer]()
	if got := reflect.TypeOf(NewFriendshipService).In(5); got != required {
		t.Fatalf("friendship constructor dependency5=%s, want explicit %s", got, required)
	}
}

func TestFriendshipConstructorRequiresDMAutoAccept(t *testing.T) {
	required := reflect.TypeFor[DMRequestAcceptor]()
	if got := reflect.TypeOf(NewFriendshipService).In(6); got != required {
		t.Fatalf("friendship constructor dependency6=%s, want explicit %s", got, required)
	}
}

func TestReactionConstructorRequiresNotificationDependencies(t *testing.T) {
	factory := reflect.TypeOf(NewReactionService)
	if factory.NumIn() != 7 {
		t.Fatalf("reaction constructor has %d inputs, want explicit notification dependency group", factory.NumIn())
	}
	dependency := factory.In(6)
	if dependency.Kind() != reflect.Struct {
		t.Fatalf("notification dependencies are not an explicit struct: %s", dependency)
	}
	for _, name := range []string{"Notifications", "Preferences", "Users"} {
		if _, ok := dependency.FieldByName(name); !ok {
			t.Errorf("notification dependency group omits %s", name)
		}
	}
}

func TestReactionDependenciesRequireNotificationWriter(t *testing.T) {
	field, _ := reflect.TypeFor[ReactionNotificationDependencies]().FieldByName("Notifications")
	if !field.Type.Implements(reflect.TypeFor[reactionNotificationCreator]()) {
		t.Fatalf("reaction dependency %s can omit reaction writer capability", field.Type)
	}
}
