package main

import (
	"database/sql"
	"reflect"
	"testing"

	"github.com/argeinfina/hichat/config"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

type failingStartupHub struct {
	services.AuthSessionDisconnecter
	services.GameJoinConnectionGate
	ws.EventPublisher
	marker any
}

func (h *failingStartupHub) OnGameJoinOffer(func(string, uint64, any) any) { panic(h.marker) }

func TestServiceInitializationReleasesCacheWhenHubWiringPanics(t *testing.T) {
	db, repos := startupServiceDependencies(t)
	before := routeCacheWorkerCount(t)
	marker := new(int)
	var caught any
	func() {
		defer func() { caught = recover() }()
		initServices(db, repos, &failingStartupHub{marker: marker}, &config.Config{}, nil, nil)
	}()
	if caught != marker {
		t.Fatalf("did not reach intended hub failure: %v", caught)
	}
	testutil.AssertWorkerCount(t, before, func() int { return routeCacheWorkerCount(t) })
}

func TestServiceInitializationReleasesCacheOnEarlyConfigFailure(t *testing.T) {
	db, repos := startupServiceDependencies(t)
	before := routeCacheWorkerCount(t)
	var caught any
	func() {
		defer func() { caught = recover() }()
		initServices(db, repos, ws.NewHub(), nil, nil, nil)
	}()
	if caught != "voice runtime requires Config" {
		t.Fatalf("did not reach configuration validation failure: %v", caught)
	}
	testutil.AssertWorkerCount(t, before, func() int { return routeCacheWorkerCount(t) })
}

func (h *failingStartupHub) IsVisibleOnline(string) (bool, error) { return false, nil }
func (h *failingStartupHub) SetDurableChannelSends(bool)          {}

func TestServiceInitializationTransfersLiveWorkersToSuccessfulCaller(t *testing.T) {
	db, repos := startupServiceDependencies(t)
	caches, limitersBefore := routeCacheWorkerCount(t), limiterWorkerCount(t)
	svcs, limiters, metrics := initServices(db, repos, ws.NewHub(), &config.Config{}, nil, nil)
	t.Cleanup(func() {
		limiters.Stop()
		stopServiceCacheWorkers(svcs)
		metrics.Stop()
		if owner, ok := svcs.Voice.(interface{ ShutdownVoiceStateFanout() }); ok {
			owner.ShutdownVoiceStateFanout()
		}
		if owner, ok := svcs.OnlineFriendNotifier.(interface{ Stop() }); ok {
			owner.Stop()
		}
		if owner, ok := svcs.LinkPreview.(interface{ Stop() }); ok {
			owner.Stop()
		}
	})
	if got := routeCacheWorkerCount(t); got != caches+4 {
		t.Fatalf("successful initialization transferred %d cache workers, want 4", got-caches)
	}
	if got := limiterWorkerCount(t); got != limitersBefore+18 {
		t.Fatalf("successful initialization transferred %d limiter workers, want 18", got-limitersBefore)
	}
	stopServiceCacheWorkers(svcs)
	limiters.Stop()
	testutil.AssertWorkerCount(t, caches, func() int { return routeCacheWorkerCount(t) })
	requireLimiterWorkerCount(t, limitersBefore)
}

func (*failingStartupHub) GameActivityEpoch() string { return "startup-fixture" }

// Startup lifecycle fixtures retain real policy readers; their intended failure
// remains the injected callback/config failure rather than missing policy input.
func startupPolicyRepositories(t *testing.T) *Repositories {
	_, repos := startupServiceDependencies(t)
	return repos
}
func startupServiceDependencies(t *testing.T) (*sql.DB, *Repositories) {
	db, _ := newCensusDB(t)
	return db.Conn, initRepositories(db.Conn, repository.DataExportStorageOptions{UploadDir: t.TempDir(), ArchiveDir: t.TempDir()})
}

func TestServiceInitializationUnwindsCacheOwnersAcrossDomainFailures(t *testing.T) {
	db, base := startupServiceDependencies(t)
	for _, scenario := range []struct{ field, want string }{
		{"DMSettings", "social messaging requires repository DMSettings"},
		{"GroupDM", "social messaging requires repository GroupDM"},
		{"Saved", "personal messaging requires repository Saved"},
		{"E2EEBackup", "device security requires repository E2EEBackup"},
		{"Feedback", "operations requires repository Feedback"},
		{"Cosmetic", "expression assets requires repository Cosmetic"},
		{"MFA", "account security requires repository MFA"},
	} {
		t.Run(scenario.field, func(t *testing.T) {
			repos := *base
			value := reflect.ValueOf(&repos).Elem().FieldByName(scenario.field)
			value.Set(reflect.Zero(value.Type()))
			cfg := &config.Config{}
			cfg.Upload.Dir = t.TempDir()
			before := routeCacheWorkerCount(t)
			var caught any
			func() {
				defer func() { caught = recover() }()
				s, l, m := initServices(db, &repos, ws.NewHub(), cfg, nil, nil)
				m.Stop()
				stopRootFixture(s, l)
			}()
			if caught != scenario.want {
				t.Fatalf("panic=%v want %s", caught, scenario.want)
			}
			testutil.AssertWorkerCount(t, before, func() int { return routeCacheWorkerCount(t) })
		})
	}
}
