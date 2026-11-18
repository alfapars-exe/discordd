package main

import (
	"fmt"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/argeinfina/hichat/config"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

func stopRootFixture(s *Services, l *RateLimiters) {
	l.Stop()
	stopServiceCacheWorkers(s)
	s.Voice.ShutdownVoiceStateFanout()
	s.OnlineFriendNotifier.Stop()
	s.LinkPreview.Stop()
	s.GameActivity.Stop()
	s.MusicBot.StopAll()
	s.Backup.Stop()
	s.AuditLog.Stop()
	s.AppLog.Stop()
}
func TestRootCompositionRejectsMissingDirectRepository(t *testing.T) {
	db, base := startupServiceDependencies(t)
	for _, field := range []string{"ServerEvent", "Server", "Role", "Channel", "Invite", "Friendship", "ServerMute", "ChannelMute", "LinkPreview", "Badge", "EmailCampaign", "AccountAssetCleanup", "Reminder", "ProfileShowcase", "ServerEventDelivery", "FriendAnniversary"} {
		for _, typedNil := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/typedNil=%v", field, typedNil), func(t *testing.T) {
				repos := *base
				v := reflect.ValueOf(&repos).Elem().FieldByName(field)
				if typedNil {
					v.Set(reflect.Zero(v.Elem().Type()))
				} else {
					v.Set(reflect.Zero(v.Type()))
				}
				cfg := &config.Config{}
				cfg.Upload.Dir = filepath.Join(t.TempDir(), "uploads")
				before := routeCacheWorkerCount(t)
				var caught any
				func() {
					defer func() { caught = recover() }()
					s, l, m := initServices(db, &repos, ws.NewHub(), cfg, nil, nil)
					m.Stop()
					stopRootFixture(s, l)
				}()
				if fmt.Sprint(caught) != "services requires repository "+field {
					t.Errorf("panic=%v want missing %s", caught, field)
				}
				testutil.AssertWorkerCount(t, before, func() int { return routeCacheWorkerCount(t) })
			})
		}
	}
}
