package services

import (
	"github.com/argeinfina/hichat/ws"
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
	if factory.NumIn() != 8 {
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

func TestPrivateReactionConstructorsRequireWriterCapability(t *testing.T) {
	required := reflect.TypeFor[reactionNotificationCreator]()
	group := reflect.TypeOf(NewGroupDMService).In(9)
	if !group.Implements(required) {
		t.Errorf("group notification input %s omits writer capability", group)
	}
	dm := reflect.TypeOf(NewDMService)
	if dm.NumIn() != 14 {
		t.Fatalf("DM constructor has %d inputs, want explicit reaction writer", dm.NumIn())
	}
	if !dm.In(12).Implements(required) {
		t.Errorf("DM notification input %s omits writer capability", dm.In(12))
	}
}

func TestReactionConstructorRequiresEmojiResolver(t *testing.T) {
	factory := reflect.TypeOf(NewReactionService)
	if factory.NumIn() != 8 {
		t.Fatalf("reaction constructor inputs=%d, want8", factory.NumIn())
	}
	if factory.In(7) != reflect.TypeFor[EmojiResolver]() {
		t.Fatal("emoji resolver is not an explicit dependency")
	}
}

func TestDMConstructorRequiresEmojiResolver(t *testing.T) {
	factory := reflect.TypeOf(NewDMService)
	if factory.NumIn() != 14 {
		t.Fatalf("DM constructor inputs=%d, want14", factory.NumIn())
	}
	if factory.In(13) != reflect.TypeFor[EmojiResolver]() {
		t.Fatal("DM emoji resolver is not explicit")
	}
}

func TestRecipientPrivateConstructorsRequireBroadcaster(t *testing.T) {
	for _, tc := range []struct {
		name    string
		factory reflect.Type
		inputs  int
	}{
		{"spam inbox", reflect.TypeOf(NewSpamInboxService), 7},
		{"media labels", reflect.TypeOf(NewMediaLabelService), 3},
	} {
		if tc.factory.NumIn() != tc.inputs {
			t.Errorf("%s constructor inputs=%d, want%d", tc.name, tc.factory.NumIn(), tc.inputs)
			continue
		}
		if tc.factory.In(tc.inputs-1) != reflect.TypeFor[ws.Broadcaster]() {
			t.Errorf("%s broadcaster is not explicit", tc.name)
		}
	}
}

func TestVoiceRequestInterfaceExcludesCompositionSetters(t *testing.T) {
	request := reflect.TypeFor[VoiceService]()
	owner := reflect.TypeFor[VoiceRuntime]()
	for _, name := range []string{"SetEntranceHook", "SetMusicBotHook", "SetAppLogger"} {
		if _, ok := request.MethodByName(name); ok {
			t.Errorf("request interface exposes %s", name)
		}
		if _, ok := owner.MethodByName(name); ok != (name == "SetAppLogger") {
			t.Errorf("runtime composition method %s has unexpected presence", name)
		}
	}
}

func TestVoiceConstructorRequiresIntegrationFactory(t *testing.T) {
	factory := reflect.TypeOf(NewVoiceService)
	if factory.NumIn() != 11 {
		t.Fatalf("voice constructor inputs=%d, want11", factory.NumIn())
	}
	if factory.In(10) != reflect.TypeFor[func(VoiceService) (VoiceEntranceHook, MusicBotChannelHook)]() {
		t.Fatal("integration factory is not explicit")
	}
}

func TestVoiceConstructorBindsIntegrationsBeforeWorkers(t *testing.T) {
	entrance := newRecordingEntranceHook()
	music := &mockMusicBotHook{}
	calls := 0
	service := NewVoiceService(nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
		func(voice VoiceService) (VoiceEntranceHook, MusicBotChannelHook) {
			calls++
			state := testVoiceState(voice)
			if state.states == nil || state.voiceFanout != nil {
				t.Fatal("factory must run after state init and before workers")
			}
			return entrance, music
		})
	t.Cleanup(service.ShutdownVoiceStateFanout)
	state := testVoiceState(service)
	if calls != 1 || state.entranceHook != entrance || state.musicBotHook != music || state.voiceFanout == nil {
		t.Fatal("integrations not bound before constructor return")
	}
}
