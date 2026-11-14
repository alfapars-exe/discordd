package services

import (
	"context"
	"database/sql"
	"github.com/argeinfina/hichat/config"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
	"log/slog"
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
		if _, ok := owner.MethodByName(name); ok {
			t.Errorf("runtime composition method %s has unexpected presence", name)
		}
	}
}

func TestVoiceConstructorRequiresIntegrationFactory(t *testing.T) {
	factory := reflect.TypeOf(NewVoiceService)
	if factory.NumIn() != 11 {
		t.Fatalf("voice constructor inputs=%d, want11", factory.NumIn())
	}
	field, ok := factory.In(10).FieldByName("Integrations")
	if !ok || field.Type != reflect.TypeFor[func(VoiceService) (VoiceEntranceHook, MusicBotChannelHook)]() {
		t.Fatal("integration factory is not explicit")
	}
}

func TestVoiceConstructorBindsIntegrationsBeforeWorkers(t *testing.T) {
	entrance := newRecordingEntranceHook()
	music := &mockMusicBotHook{}
	calls := 0
	service := NewVoiceService(nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
		VoiceRuntimeDependencies{Integrations: func(voice VoiceService) (VoiceEntranceHook, MusicBotChannelHook) {
			calls++
			state := testVoiceState(voice)
			if state.states == nil || state.voiceFanout != nil {
				t.Fatal("factory must run after state init and before workers")
			}
			return entrance, music
		}})
	t.Cleanup(service.ShutdownVoiceStateFanout)
	state := testVoiceState(service)
	if calls != 1 || state.entranceHook != entrance || state.musicBotHook != music || state.voiceFanout == nil {
		t.Fatal("integrations not bound before constructor return")
	}
}

func TestVoiceConstructorFactoryPanicPrecedesWorkerAllocation(t *testing.T) {
	marker := new(int)
	var captured *voiceService
	var recovered any
	func() {
		defer func() { recovered = recover() }()
		NewVoiceService(nil, nil, nil, nil, nil, nil, nil, nil, nil, nil,
			VoiceRuntimeDependencies{Integrations: func(voice VoiceService) (VoiceEntranceHook, MusicBotChannelHook) {
				captured = testVoiceState(voice)
				panic(marker)
			}})
	}()
	if recovered != marker || captured == nil || captured.states == nil || captured.voiceFanout != nil {
		t.Fatal("factory panic must retain its value without allocating voice workers")
	}
}

func TestVoiceConstructorExplicitDisabledIntegrations(t *testing.T) {
	for _, useFactory := range []bool{false, true} {
		calls := 0
		var factory func(VoiceService) (VoiceEntranceHook, MusicBotChannelHook)
		if useFactory {
			factory = func(VoiceService) (VoiceEntranceHook, MusicBotChannelHook) { calls++; return nil, nil }
		}
		service := NewVoiceService(nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, VoiceRuntimeDependencies{Integrations: factory})
		t.Cleanup(service.ShutdownVoiceStateFanout)
		state := testVoiceState(service)
		wantCalls := 0
		if useFactory {
			wantCalls = 1
		}
		if state.entranceHook != nil || state.musicBotHook != nil || state.voiceFanout == nil || calls != wantCalls {
			t.Fatal("disabled integration contract changed")
		}
	}
}

func TestVoiceConstructorRequiresRuntimeDependencyGroup(t *testing.T) {
	factory := reflect.TypeOf(NewVoiceService)
	dependency := factory.In(factory.NumIn() - 1)
	if dependency.Kind() != reflect.Struct {
		t.Fatalf("runtime dependencies are not a struct: %s", dependency)
	}
	for _, name := range []string{"Integrations", "AppLogger", "FreshPermissions", "VoiceAccess", "UsageRecovery", "UsageCredit"} {
		if _, ok := dependency.FieldByName(name); !ok {
			t.Errorf("runtime dependencies omit %s", name)
		}
	}
}

type constructorVoiceLogger struct{ levels []models.LogLevel }

func (l *constructorVoiceLogger) Log(_ context.Context, level models.LogLevel, _ models.LogCategory, _, _ *string, _ string, _ map[string]string) {
	l.levels = append(l.levels, level)
}

func TestVoiceConstructorLoggerIsReadyBeforeIntegrationFactory(t *testing.T) {
	logger := &constructorVoiceLogger{}
	service := NewVoiceService(nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, VoiceRuntimeDependencies{
		AppLogger: logger,
		Integrations: func(voice VoiceService) (VoiceEntranceHook, MusicBotChannelHook) {
			state := testVoiceState(voice)
			if state.appLogger != logger {
				t.Fatal("logger not installed before integration factory")
			}
			state.logInfo(models.LogCategoryVoice, nil, "constructor fixture", nil)
			return nil, nil
		},
	})
	t.Cleanup(service.ShutdownVoiceStateFanout)
	testVoiceState(service).logError(models.LogCategoryVoice, nil, "runtime fixture", nil)
	if len(logger.levels) != 2 || logger.levels[0] != models.LogLevelInfo || logger.levels[1] != models.LogLevelError {
		t.Fatal("constructor logger did not retain both logging paths")
	}
}

func TestP2PConstructorRequiresLogger(t *testing.T) {
	factory := reflect.TypeOf(NewP2PCallService)
	if factory.NumIn() != 5 {
		t.Fatalf("P2P constructor inputs=%d, want5", factory.NumIn())
	}
	if factory.In(4) != reflect.TypeFor[P2PAppLogger]() {
		t.Fatal("P2P logger is not explicit")
	}
	if _, ok := reflect.TypeFor[P2PCallService]().MethodByName("SetAppLogger"); ok {
		t.Fatal("P2P request interface exposes logger mutation")
	}
}

func TestP2PConstructorLoggerAndExplicitDisabledMode(t *testing.T) {
	logger := &constructorVoiceLogger{}
	service := NewP2PCallService(nil, nil, nil, nil, logger).(*p2pCallService)
	service.logError(nil, "P2P constructor fixture", nil)
	if len(logger.levels) != 1 || logger.levels[0] != models.LogLevelError {
		t.Fatal("P2P constructor logger not used")
	}
	disabled := NewP2PCallService(nil, nil, nil, nil, nil).(*p2pCallService)
	disabled.logError(nil, "disabled fixture", nil)
	if disabled.appLogger != nil {
		t.Fatal("disabled logger not retained")
	}
}

func TestAuthRequestInterfaceExcludesLoggerMutation(t *testing.T) {
	if _, ok := reflect.TypeFor[AuthService]().MethodByName("SetAppLogger"); ok {
		t.Fatal("auth request interface exposes logger mutation")
	}
}

func TestAuthConstructorLoggerOptionAndDisabledMode(t *testing.T) {
	logger := &constructorVoiceLogger{}
	service := NewAuthService(nil, nil, nil, nil, nil, nil, "constructor-test-key", 15, 7, WithAuthAppLogger(logger)).(*authService)
	service.logWarn(context.Background(), nil, "constructor logger fixture", nil)
	if len(logger.levels) != 1 || logger.levels[0] != models.LogLevelWarn {
		t.Fatal("auth constructor logger did not receive warning")
	}
	disabled := NewAuthService(nil, nil, nil, nil, nil, nil, "constructor-test-key", 15, 7, WithAuthAppLogger(nil)).(*authService)
	disabled.logWarn(context.Background(), nil, "disabled logger fixture", nil)
	if disabled.appLogger != nil {
		t.Fatal("explicit disabled auth logger changed")
	}
}

func TestBackupConstructorRequiresLogger(t *testing.T) {
	factory := reflect.TypeOf(NewBackupService)
	if factory.NumIn() != 2 {
		t.Fatalf("backup constructor inputs=%d, want2", factory.NumIn())
	}
	if factory.In(1) != reflect.TypeFor[BackupAppLogger]() {
		t.Fatal("backup logger is not explicit")
	}
}

func TestBackupConstructorLoggingAndDisabledMode(t *testing.T) {
	logger := &constructorVoiceLogger{}
	service := NewBackupService(config.BackupConfig{}, logger)
	t.Cleanup(service.Stop)
	service.logInfo("constructor backup fixture", nil)
	service.logError("constructor backup fixture", nil)
	if len(logger.levels) != 2 || logger.levels[0] != models.LogLevelInfo || logger.levels[1] != models.LogLevelError {
		t.Fatal("backup constructor logger not used")
	}
	disabled := NewBackupService(config.BackupConfig{}, nil)
	t.Cleanup(disabled.Stop)
	disabled.logInfo("disabled fixture", nil)
	if disabled.appLogger != nil {
		t.Fatal("disabled logger changed")
	}
}

func TestIdentityWritersRequireCacheInvalidator(t *testing.T) {
	admin := reflect.TypeOf(NewAdminUserService)
	if admin.NumIn() != 5 {
		t.Errorf("admin constructor inputs=%d, want5", admin.NumIn())
	} else if admin.In(4) != reflect.TypeFor[UserCacheInvalidator]() {
		t.Error("admin invalidator is not explicit")
	}
	member := reflect.TypeOf(NewMemberService)
	if member.NumIn() != 14 {
		t.Errorf("member constructor inputs=%d, want14", member.NumIn())
	} else if member.In(11) != reflect.TypeFor[UserCacheInvalidator]() {
		t.Error("member invalidator is not explicit")
	}
	for _, request := range []reflect.Type{reflect.TypeFor[AdminUserService](), reflect.TypeFor[MemberService]()} {
		if _, ok := request.MethodByName("SetUserCacheInvalidator"); ok {
			t.Errorf("request interface %s exposes cache binding", request)
		}
	}
}

func TestRoleConstructorRequiresPermissionInvalidator(t *testing.T) {
	factory := reflect.TypeOf(NewRoleService)
	if factory.NumIn() != 5 {
		t.Fatalf("role constructor inputs=%d, want5", factory.NumIn())
	}
	if factory.In(4) != reflect.TypeFor[PermissionInvalidator]() {
		t.Fatal("role invalidator is not explicit")
	}
	if _, ok := reflect.TypeFor[RoleService]().MethodByName("SetPermInvalidator"); ok {
		t.Fatal("role request interface exposes cache wiring")
	}
}

func TestMemberConstructorRequiresPermissionInvalidator(t *testing.T) {
	factory := reflect.TypeOf(NewMemberService)
	if factory.NumIn() != 14 {
		t.Fatalf("member constructor inputs=%d, want14", factory.NumIn())
	}
	if factory.In(12) != reflect.TypeFor[PermissionInvalidator]() {
		t.Fatal("member permission invalidator is not explicit")
	}
	if _, ok := reflect.TypeFor[MemberService]().MethodByName("SetPermInvalidator"); ok {
		t.Fatal("member request interface exposes permission wiring")
	}
}

func TestServerConstructorRequiresPermissionInvalidator(t *testing.T) {
	factory := reflect.TypeOf(NewServerService)
	if factory.NumIn() != 18 {
		t.Fatalf("server constructor inputs=%d, want18", factory.NumIn())
	}
	if factory.In(16) != reflect.TypeFor[PermissionInvalidator]() {
		t.Fatal("server permission invalidator is not explicit")
	}
	if _, ok := reflect.TypeFor[ServerService]().MethodByName("SetPermInvalidator"); ok {
		t.Fatal("server request interface exposes permission wiring")
	}
}

func TestAppLogFactoryDeclaresSinkAndHealthCapabilities(t *testing.T) {
	result := reflect.TypeOf(NewAppLogService).Out(0)
	required := reflect.TypeFor[interface {
		ConsumeRecord(context.Context, slog.Record)
		Health() models.AppLogHealth
	}]()
	if !result.Implements(required) {
		t.Fatalf("app log factory result %s omits sink/health", result)
	}
}

func TestBotConstructorDeclaresRuntimeDependencies(t *testing.T) {
	factory := reflect.TypeOf(NewBotService)
	if factory.IsVariadic() || factory.NumIn() != 2 || factory.In(1).Kind() != reflect.Struct {
		t.Fatal("bot runtime dependencies must be an explicit constructor struct")
	}
	for _, name := range []string{"Disconnecter", "Broadcaster", "Permissions", "Memberships"} {
		if _, ok := factory.In(1).FieldByName(name); !ok {
			t.Fatalf("missing runtime dependency %s", name)
		}
	}
}

func TestOnlineFriendFactoryDeclaresPresenceLifecycleCapability(t *testing.T) {
	result := reflect.TypeOf(NewOnlineFriendNotifier).Out(0)
	required := reflect.TypeFor[interface {
		NotifyOnlinePresence(string) error
		ObserveOffline(string)
	}]()
	if !result.Implements(required) {
		t.Fatalf("factory result %s hides presence lifecycle capability", result)
	}
}

func TestOnlineFriendConstructorDeclaresGuardedWriterAndCandidateReader(t *testing.T) {
	factory := reflect.TypeOf(NewOnlineFriendNotifier)
	if factory.NumIn() != 7 {
		t.Fatalf("online friend constructor inputs=%d, want7", factory.NumIn())
	}
	if factory.In(3) != reflect.TypeFor[repository.OnlineFriendNotificationRepository]() {
		t.Fatal("guarded writer must be explicit")
	}
	if factory.In(6) != reflect.TypeFor[repository.OnlineFriendCandidateReader]() {
		t.Fatal("candidate reader must be explicit")
	}
	output := reflect.TypeOf(repository.NewSQLiteNotificationRepo).Out(0)
	if !output.Implements(factory.In(3)) || !output.Implements(factory.In(6)) {
		t.Fatal("production notification factory hides presence capabilities")
	}
}

func TestMessageConstructorDeclaresDurableDeliveryDatabase(t *testing.T) {
	factory := reflect.TypeOf(NewMessageService)
	if factory.NumIn() != 16 {
		t.Fatalf("message constructor inputs=%d want16", factory.NumIn())
	}
	if factory.In(15) != reflect.TypeFor[*sql.DB]() {
		t.Fatal("durable delivery database must be explicit")
	}
}

func TestMessageFactoryDeclaresDeliveryRuntime(t *testing.T) {
	result := reflect.TypeOf(NewMessageService).Out(0)
	required := reflect.TypeFor[interface {
		CompleteChannelSend(context.Context, *models.Message) error
		AttachmentOutcome(context.Context, string, int, *models.Attachment, string) error
		StartChannelDelivery(context.Context) func()
	}]()
	if !result.Implements(required) {
		t.Fatalf("factory result %s hides delivery runtime", result)
	}
}

func TestGroupConstructorDeclaresPostcommitNotificationDelivery(t *testing.T) {
	factory := reflect.TypeOf(NewGroupDMService)
	if factory.NumIn() != 13 {
		t.Fatalf("group constructor inputs=%d want13", factory.NumIn())
	}
	required := reflect.TypeFor[interface {
		DeliverCommittedGroupNotifications(context.Context, string, string, func(*models.Notification)) error
	}]()
	if !factory.In(12).Implements(required) {
		t.Fatal("group notification delivery must be explicit")
	}
}

func TestGameJoinConstructorDeclaresPhysicalConnectionGate(t *testing.T) {
	factory := reflect.TypeOf(NewGameJoinService)
	if factory.NumIn() != 3 {
		t.Fatalf("game join constructor inputs=%d want3", factory.NumIn())
	}
	required := reflect.TypeFor[interface {
		WithGameActivityConnection(string, uint64, func() error) error
		ValidateGameActivityConnection(context.Context, string, uint64) error
		HasGameActivityConnection(string, uint64) bool
	}]()
	if !factory.In(2).Implements(required) {
		t.Fatal("physical connection gate must be explicit")
	}
}

func TestMembershipTransactionDeclaresPrivacySnapshotDependencies(t *testing.T) {
	repos := reflect.TypeFor[repository.ServerMembershipTxRepos]()
	for _, name := range []string{"GameActivityCounter", "GameActivityWriter"} {
		if _, ok := repos.FieldByName(name); !ok {
			t.Fatalf("transaction bundle hides %s", name)
		}
	}
}

func TestServerConstructorDeclaresMembershipSnapshotReader(t *testing.T) {
	factory := reflect.TypeOf(NewServerService)
	if factory.NumIn() != 18 {
		t.Fatalf("server constructor inputs=%d want18", factory.NumIn())
	}
	required := reflect.TypeFor[interface {
		GetMemberGameActivityAudience(context.Context, string, string) (*bool, error)
	}]()
	if !factory.In(17).Implements(required) {
		t.Fatal("post-join snapshot reader must be explicit")
	}
}

func TestLiveKitFactoryDeclaresDurableUsageCapabilities(t *testing.T) {
	result := reflect.TypeOf(repository.NewSQLiteLiveKitRepo).Out(0)
	for _, required := range []reflect.Type{reflect.TypeFor[repository.VoiceUsageRecorder](), reflect.TypeFor[repository.VoiceUsageQueue]()} {
		if !result.Implements(required) {
			t.Fatalf("LiveKit factory result %s hides %s", result, required)
		}
	}
}

func TestAppLogConstructorDeclaresOptionalBatchWriter(t *testing.T) {
	factory := reflect.TypeOf(NewAppLogService)
	if factory.NumIn() != 2 {
		t.Fatalf("app log constructor inputs=%d want2", factory.NumIn())
	}
	required := reflect.TypeFor[interface {
		InsertBatch(context.Context, []models.AppLog) (int64, error)
	}]()
	if !factory.In(1).Implements(required) {
		t.Fatal("batch writer must be explicit")
	}
}
