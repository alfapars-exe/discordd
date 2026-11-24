package services

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

// ─── Voice state fanout on the snapshot path (voiceAccess != nil) ───
//
// A move or a channel switch queues a leave for the source channel directly
// followed by a join for the target. These pin that the worker resolves the
// audiences of one server's consecutive events with a single visibility read
// and still publishes every event, in queue order, to its own channel's
// audience.

type fanoutSnapshotRead struct {
	serverID   string
	channelIDs []string
	online     []string
}

// fanoutSnapshotAccess answers the visibility read per (server, channel) and
// records every read. The admission and token reads are not part of the
// fanout; reaching one panics on the nil embedded reader.
type fanoutSnapshotAccess struct {
	repository.VoiceAccessReader

	mu        sync.Mutex
	audiences map[string][]string // "server/channel" -> visible users
	failing   map[string]error    // by server
	failOnce  map[string]error    // by server; consumed by the first read
	reads     []fanoutSnapshotRead
	onRead    func(serverID string) // runs inside the read, outside mu
}

func (a *fanoutSnapshotAccess) VoiceVisibleUsers(context.Context, string, string, []string) ([]string, error) {
	return nil, errors.New("the fanout must use the per-server visibility read")
}

func (a *fanoutSnapshotAccess) VoiceVisibleUsersByChannel(_ context.Context, serverID string, channelIDs, online []string) (map[string][]string, error) {
	a.mu.Lock()
	a.reads = append(a.reads, fanoutSnapshotRead{serverID: serverID, channelIDs: slices.Clone(channelIDs), online: slices.Clone(online)})
	hook := a.onRead
	a.mu.Unlock()
	if hook != nil {
		hook(serverID)
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := a.failing[serverID]; err != nil {
		return nil, err
	}
	if err := a.failOnce[serverID]; err != nil {
		delete(a.failOnce, serverID)
		return nil, err
	}
	visible := make(map[string][]string)
	for _, channelID := range channelIDs {
		if ids, ok := a.audiences[serverID+"/"+channelID]; ok {
			visible[channelID] = ids
		}
	}
	return visible, nil
}

func (a *fanoutSnapshotAccess) recorded() []fanoutSnapshotRead {
	a.mu.Lock()
	defer a.mu.Unlock()
	return slices.Clone(a.reads)
}

type fanoutSnapshotHub struct {
	testutil.MockEventPublisher
	online map[string][]string
}

func (h *fanoutSnapshotHub) GetOnlineUserIDsForServer(serverID string) []string {
	return h.online[serverID]
}

type fanoutSnapshotDelivery struct {
	label     string // the event's UserID, used as its name in the test
	channelID string
	audience  []string
}

type fanoutSnapshotFixture struct {
	svc       *voiceService
	fanout    *voiceStateFanout
	access    *fanoutSnapshotAccess
	delivered chan fanoutSnapshotDelivery
	primed    chan struct{}
	release   chan struct{}
}

// newFanoutSnapshotFixture wires a service whose portable resolvers fail the
// test when touched: with a snapshot reader the fanout must not fall back.
func newFanoutSnapshotFixture(t *testing.T, online, audiences map[string][]string) *fanoutSnapshotFixture {
	t.Helper()
	f := &fanoutSnapshotFixture{
		access:    &fanoutSnapshotAccess{audiences: audiences, failing: map[string]error{}},
		delivered: make(chan fanoutSnapshotDelivery, 64),
		primed:    make(chan struct{}),
		release:   make(chan struct{}),
	}
	hub := &fanoutSnapshotHub{online: map[string][]string{"primer": {"primer-user"}}}
	for serverID, ids := range online {
		hub.online[serverID] = ids
	}
	hub.BroadcastToUsersFn = func(ids []string, event ws.Event) {
		data := event.Data.(ws.VoiceStateUpdateBroadcast)
		f.delivered <- fanoutSnapshotDelivery{label: data.UserID, channelID: data.ChannelID, audience: slices.Clone(ids)}
	}
	members := fanoutTestMembers{}
	f.svc = &voiceService{
		fanoutAudience: VoiceFanoutDependencies{Online: hub, Members: members},
		channelGetter: fanoutTestChannels{lookup: func(context.Context) (*models.Channel, error) {
			t.Error("snapshot fanout looked the channel up through the portable getter")
			return nil, errors.New("portable path")
		}},
		hub: hub,
		permResolver: &testutil.MockChannelPermResolver{ResolveChannelPermissionsBulkFn: func(context.Context, string, []string) (map[string]models.Permission, error) {
			t.Error("snapshot fanout resolved permissions through the portable resolver")
			return nil, errors.New("portable path")
		}},
		afkTimeoutGetter: members,
		voiceAccess:      f.access,
	}
	f.fanout = newVoiceStateFanout(f.svc)
	f.svc.voiceFanout = f.fanout
	t.Cleanup(f.fanout.shutdown)
	return f
}

func (f *fanoutSnapshotFixture) submit(serverID, channelID, label string) {
	f.fanout.submit(serverID, ws.Event{Op: ws.OpVoiceStateUpdate, Data: ws.VoiceStateUpdateBroadcast{ChannelID: channelID, UserID: label}})
}

// queueAsOneBatch parks the worker inside the visibility read of a primer
// event, queues the given events behind it and lets the worker go: it then
// drains exactly these events as one batch. The primer's read is removed
// from the recorded reads.
func (f *fanoutSnapshotFixture) queueAsOneBatch(t *testing.T, events ...[3]string) {
	t.Helper()
	f.access.mu.Lock()
	f.access.onRead = func(serverID string) {
		if serverID == "primer" {
			close(f.primed)
			<-f.release
		}
	}
	f.access.mu.Unlock()
	f.submit("primer", "primer-channel", "primer")
	select {
	case <-f.primed:
	case <-time.After(2 * time.Second):
		t.Fatal("worker did not start the primer's visibility read")
	}
	for _, event := range events {
		f.submit(event[0], event[1], event[2])
	}
	close(f.release)
}

// drain stops the worker (everything accepted has then been published or
// dropped) and returns the deliveries and the reads without the primer's.
func (f *fanoutSnapshotFixture) drain(t *testing.T, published int) ([]fanoutSnapshotDelivery, []fanoutSnapshotRead) {
	t.Helper()
	deliveries := make([]fanoutSnapshotDelivery, 0, published)
	for len(deliveries) < published {
		select {
		case delivery := <-f.delivered:
			deliveries = append(deliveries, delivery)
		case <-time.After(2 * time.Second):
			t.Fatalf("published %d of %d events: %v", len(deliveries), published, deliveries)
		}
	}
	f.fanout.shutdown()
	select {
	case extra := <-f.delivered:
		t.Fatalf("unexpected extra publication %v", extra)
	default:
	}
	reads := f.access.recorded()
	if len(reads) == 0 || reads[0].serverID != "primer" {
		t.Fatalf("first read is not the primer's: %v", reads)
	}
	return deliveries, reads[1:]
}

func fanoutDeliveryLabels(deliveries []fanoutSnapshotDelivery) []string {
	labels := make([]string, len(deliveries))
	for i, delivery := range deliveries {
		labels[i] = delivery.label
	}
	return labels
}

func TestVoiceFanoutSnapshot_TwoChannelsOfOneServerShareOneRead(t *testing.T) {
	online := map[string][]string{"srv1": {"alice", "bob", "carol", "alice", ""}}
	f := newFanoutSnapshotFixture(t, online, map[string][]string{
		"srv1/source": {"alice", "bob"},
		"srv1/target": {"carol"},
	})
	// leave(source) + join(target), then a later update in each channel.
	f.queueAsOneBatch(t,
		[3]string{"srv1", "source", "leave"},
		[3]string{"srv1", "target", "join"},
		[3]string{"srv1", "source", "update-source"},
		[3]string{"srv1", "target", "update-target-1"},
		[3]string{"srv1", "target", "update-target-2"},
	)
	deliveries, reads := f.drain(t, 5)

	if len(reads) != 1 {
		t.Fatalf("%d visibility reads for one server's batch, want 1: %v", len(reads), reads)
	}
	if reads[0].serverID != "srv1" || !reflect.DeepEqual(reads[0].channelIDs, []string{"source", "target"}) {
		t.Fatalf("read scope %v, want srv1 [source target]", reads[0])
	}
	if !reflect.DeepEqual(reads[0].online, online["srv1"]) {
		t.Fatalf("read candidates %v, want the server's online list %v", reads[0].online, online["srv1"])
	}
	want := []fanoutSnapshotDelivery{
		{"leave", "source", []string{"alice", "bob"}},
		{"join", "target", []string{"carol"}},
		{"update-source", "source", []string{"alice", "bob"}},
		{"update-target-1", "target", []string{"carol"}},
		{"update-target-2", "target", []string{"carol"}},
	}
	if !reflect.DeepEqual(deliveries, want) {
		t.Fatalf("publications\n got %v\nwant %v", deliveries, want)
	}
	if dropped := f.fanout.dropped(); dropped != 0 {
		t.Fatalf("%d events dropped", dropped)
	}
}

func TestVoiceFanoutSnapshot_ServersKeepSeparateReads(t *testing.T) {
	online := map[string][]string{"srv1": {"alice"}, "srv2": {"dave"}}
	audiences := map[string][]string{
		"srv1/a": {"alice"}, "srv1/b": {"alice"},
		"srv2/c": {"dave"}, "srv2/d": {"dave"},
	}
	t.Run("one run per server", func(t *testing.T) {
		f := newFanoutSnapshotFixture(t, online, audiences)
		f.queueAsOneBatch(t,
			[3]string{"srv1", "a", "1"}, [3]string{"srv1", "b", "2"},
			[3]string{"srv2", "c", "3"}, [3]string{"srv2", "d", "4"}, [3]string{"srv2", "c", "5"},
		)
		deliveries, reads := f.drain(t, 5)
		wantReads := []fanoutSnapshotRead{
			{"srv1", []string{"a", "b"}, []string{"alice"}},
			{"srv2", []string{"c", "d"}, []string{"dave"}},
		}
		if !reflect.DeepEqual(reads, wantReads) {
			t.Fatalf("reads\n got %v\nwant %v", reads, wantReads)
		}
		if got := fanoutDeliveryLabels(deliveries); !reflect.DeepEqual(got, []string{"1", "2", "3", "4", "5"}) {
			t.Fatalf("publication order %v", got)
		}
		for _, delivery := range deliveries {
			want := []string{"alice"}
			if delivery.channelID == "c" || delivery.channelID == "d" {
				want = []string{"dave"}
			}
			if !reflect.DeepEqual(delivery.audience, want) {
				t.Fatalf("event %s for channel %s went to %v", delivery.label, delivery.channelID, delivery.audience)
			}
		}
	})
	// A read is reused only while no other server's read comes in between:
	// srv1's second run is read again, after srv2's events have gone out,
	// rather than published from an audience read before srv2's statement.
	t.Run("interleaved servers read per run", func(t *testing.T) {
		f := newFanoutSnapshotFixture(t, online, audiences)
		f.queueAsOneBatch(t,
			[3]string{"srv1", "a", "1"}, [3]string{"srv2", "c", "2"}, [3]string{"srv1", "b", "3"},
		)
		deliveries, reads := f.drain(t, 3)
		wantReads := []fanoutSnapshotRead{
			{"srv1", []string{"a"}, []string{"alice"}},
			{"srv2", []string{"c"}, []string{"dave"}},
			{"srv1", []string{"b"}, []string{"alice"}},
		}
		if !reflect.DeepEqual(reads, wantReads) {
			t.Fatalf("reads\n got %v\nwant %v", reads, wantReads)
		}
		if got := fanoutDeliveryLabels(deliveries); !reflect.DeepEqual(got, []string{"1", "2", "3"}) {
			t.Fatalf("publication order %v", got)
		}
	})
}

func TestVoiceFanoutSnapshot_FailedReadDropsThatServersEvents(t *testing.T) {
	online := map[string][]string{"srv1": {"alice"}, "srv2": {"dave"}}
	f := newFanoutSnapshotFixture(t, online, map[string][]string{
		"srv1/a": {"alice"}, "srv1/b": {"alice"}, "srv2/c": {"dave"},
	})
	f.access.failing["srv1"] = errors.New("visibility statement failed")
	f.queueAsOneBatch(t,
		[3]string{"srv1", "a", "lost-1"}, [3]string{"srv1", "b", "lost-2"}, [3]string{"srv1", "a", "lost-3"},
		[3]string{"srv2", "c", "kept"},
	)
	deliveries, reads := f.drain(t, 1)
	if len(deliveries) != 1 || deliveries[0].label != "kept" || !reflect.DeepEqual(deliveries[0].audience, []string{"dave"}) {
		t.Fatalf("publications %v, want only srv2's event", deliveries)
	}
	// A failed read is not shared: each of srv1's three channel groups makes
	// its own attempt, as each did when every group had its own statement.
	if len(reads) != 4 || reads[0].serverID != "srv1" || reads[1].serverID != "srv1" || reads[2].serverID != "srv1" || reads[3].serverID != "srv2" {
		t.Fatalf("reads %v, want one per srv1 group and one for srv2", reads)
	}
	if dropped := f.fanout.dropped(); dropped != 3 {
		t.Fatalf("%d events counted as dropped, want srv1's 3", dropped)
	}
}

// A move queues leave(source) directly followed by join(target). When the
// statement fails once, only the group that asked loses its events: the next
// group reads again, and its successful read is shared by the rest of the run.
func TestVoiceFanoutSnapshot_FailedReadIsRetriedByTheNextGroup(t *testing.T) {
	online := map[string][]string{"srv1": {"alice", "bob"}}
	f := newFanoutSnapshotFixture(t, online, map[string][]string{
		"srv1/source": {"alice"}, "srv1/target": {"bob"},
	})
	f.access.failOnce = map[string]error{"srv1": errors.New("connection reset")}
	f.queueAsOneBatch(t,
		[3]string{"srv1", "source", "leave"},
		[3]string{"srv1", "target", "join"},
		[3]string{"srv1", "source", "update-source"},
		[3]string{"srv1", "target", "update-target"},
	)
	deliveries, reads := f.drain(t, 3)
	want := []fanoutSnapshotDelivery{
		{"join", "target", []string{"bob"}},
		{"update-source", "source", []string{"alice"}},
		{"update-target", "target", []string{"bob"}},
	}
	if !reflect.DeepEqual(deliveries, want) {
		t.Fatalf("publications\n got %v\nwant %v", deliveries, want)
	}
	// The failed attempt and one retry; the retry's answer serves the
	// remaining groups without a third statement.
	wantRead := fanoutSnapshotRead{"srv1", []string{"source", "target"}, []string{"alice", "bob"}}
	if !reflect.DeepEqual(reads, []fanoutSnapshotRead{wantRead, wantRead}) {
		t.Fatalf("reads %v, want the failed read and one retry", reads)
	}
	if dropped := f.fanout.dropped(); dropped != 1 {
		t.Fatalf("%d events counted as dropped, want only the leave", dropped)
	}
}

func TestVoiceFanoutSnapshot_ChannelWithoutAudiencePublishesNothing(t *testing.T) {
	online := map[string][]string{"srv1": {"alice"}, "empty": nil}
	// "hidden" is absent from the read's answer, as a text channel, another
	// server's channel or a channel nobody may view is.
	f := newFanoutSnapshotFixture(t, online, map[string][]string{"srv1/open": {"alice"}})
	f.queueAsOneBatch(t,
		[3]string{"srv1", "hidden", "unseen-1"}, [3]string{"srv1", "open", "seen"}, [3]string{"srv1", "hidden", "unseen-2"},
		[3]string{"empty", "x", "nobody-online"},
	)
	deliveries, reads := f.drain(t, 1)
	if len(deliveries) != 1 || deliveries[0].label != "seen" || deliveries[0].channelID != "open" {
		t.Fatalf("publications %v, want only the open channel's event", deliveries)
	}
	// A server with nobody online is not read at all.
	if len(reads) != 1 || !reflect.DeepEqual(reads[0].channelIDs, []string{"hidden", "open"}) {
		t.Fatalf("reads %v, want one for srv1 [hidden open]", reads)
	}
	// As before the change: no audience is not a failure, nothing is counted.
	if dropped := f.fanout.dropped(); dropped != 0 {
		t.Fatalf("%d events counted as dropped", dropped)
	}
}

// The worker bounds a batch at 16 events, so one read never names more than
// 16 channels however many are queued.
func TestVoiceFanoutSnapshot_ReadIsBoundedByTheBatch(t *testing.T) {
	audiences := map[string][]string{}
	events := make([][3]string, 0, 40)
	for i := 0; i < 40; i++ {
		channelID := fmt.Sprintf("c%02d", i)
		audiences["srv1/"+channelID] = []string{"alice"}
		events = append(events, [3]string{"srv1", channelID, channelID})
	}
	f := newFanoutSnapshotFixture(t, map[string][]string{"srv1": {"alice"}}, audiences)
	f.queueAsOneBatch(t, events...)
	deliveries, reads := f.drain(t, 40)
	for i, delivery := range deliveries {
		if delivery.label != events[i][2] {
			t.Fatalf("publication %d is %s, want %s", i, delivery.label, events[i][2])
		}
	}
	seen := 0
	for _, read := range reads {
		if len(read.channelIDs) == 0 || len(read.channelIDs) > 16 {
			t.Fatalf("read names %d channels", len(read.channelIDs))
		}
		seen += len(read.channelIDs)
	}
	if seen != 40 || len(reads) != 3 {
		t.Fatalf("%d reads naming %d channels, want 3 naming 40", len(reads), seen)
	}
}
