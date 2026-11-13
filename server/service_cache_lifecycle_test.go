package main

import (
	"os"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/services"
)

type permissionCacheStopOwner struct {
	services.ChannelPermissionService
	calls int
}

func (s *permissionCacheStopOwner) Stop() { s.calls++ }

type ticketCacheStopOwner struct {
	services.WSTicketService
	calls int
}

func (s *ticketCacheStopOwner) Stop() { s.calls++ }

func TestServiceCacheShutdownVisitsBothOwnersAndToleratesAbsentServices(t *testing.T) {
	permissions, tickets := &permissionCacheStopOwner{}, &ticketCacheStopOwner{}
	stopServiceCacheWorkers(&Services{ChannelPermission: permissions, WSTicket: tickets})
	if permissions.calls != 1 || tickets.calls != 1 {
		t.Fatalf("cache owners stopped %d/%d times", permissions.calls, tickets.calls)
	}
	stopServiceCacheWorkers(nil)
	stopServiceCacheWorkers(&Services{})
	stopServiceCacheWorkers(&Services{ChannelPermission: &struct {
		services.ChannelPermissionService
	}{}, WSTicket: &struct{ services.WSTicketService }{}})
}

func TestMainRegistersCacheCleanupAfterServiceAcquisition(t *testing.T) {
	data, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(data)
	acquired := strings.Index(source, "svcs, limiters, metricsCollector := initServices(")
	cleanup := strings.Index(source, "defer stopServiceCacheWorkers(svcs)")
	if acquired < 0 || cleanup < acquired || strings.Count(source, "defer stopServiceCacheWorkers(svcs)") != 1 {
		t.Fatal("main lacks one owned cleanup after service acquisition")
	}
}

func TestMainRegistersMiddlewareCacheCleanupAfterRouteAcquisition(t *testing.T) {
	data, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(data)
	acquired := strings.Index(source, "authMw, permMw := initRoutes(")
	for _, cleanup := range []string{"defer authMw.Stop()", "defer permMw.Stop()"} {
		if acquired < 0 || strings.Index(source, cleanup) < acquired || strings.Count(source, cleanup) != 1 {
			t.Fatalf("main lacks one owned middleware cleanup: %s", cleanup)
		}
	}
}
