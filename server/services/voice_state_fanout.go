package services

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/ws"
)

const (
	voiceStateFanoutQueueLimit = 256
	voiceStateFanoutMaxOnline  = 4096
	voiceStateFanoutMaxMembers = 100_000
	voiceStateFanoutIdle       = time.Second
)

type voiceStateFanoutMembership interface {
	ListMemberIDs(ctx context.Context, serverID string) ([]string, error)
}

type voiceStateFanoutEvent struct {
	serverID  string
	channelID string
	event     ws.Event
}

// voiceStateFanout owns a single on-demand worker: accepted events are
// processed FIFO, while the bounded queue makes overload fail closed instead
// of blocking a voice-state mutation or spawning work per event.
type voiceStateFanout struct {
	mu        sync.Mutex
	queue     chan voiceStateFanoutEvent
	worker    bool
	workerID  uint64
	stopping  bool
	stop      chan struct{}
	workerWG  sync.WaitGroup
	dropCount atomic.Uint64
	service   *voiceService
	ctx       context.Context
	cancel    context.CancelFunc
}

func newVoiceStateFanout(service *voiceService) *voiceStateFanout {
	ctx, cancel := context.WithCancel(context.Background())
	return &voiceStateFanout{
		queue:   make(chan voiceStateFanoutEvent, voiceStateFanoutQueueLimit),
		stop:    make(chan struct{}),
		service: service,
		ctx:     ctx,
		cancel:  cancel,
	}
}

func snapshotVoiceEvent(event ws.Event) (string, ws.Event, bool) {
	switch data := event.Data.(type) {
	case ws.VoiceStateUpdateBroadcast:
		return data.ChannelID, event, true
	case *ws.VoiceStateUpdateBroadcast:
		if data != nil {
			event.Data = *data
			return data.ChannelID, event, true
		}
	case ws.ScreenShareViewerUpdateData:
		data.ViewerUserIDs = append([]string{}, data.ViewerUserIDs...)
		event.Data = data
		return data.ChannelID, event, true
	case *ws.ScreenShareViewerUpdateData:
		if data != nil {
			copy := *data
			copy.ViewerUserIDs = append([]string{}, data.ViewerUserIDs...)
			event.Data = copy
			return data.ChannelID, event, true
		}
	}
	return "", event, false
}

func (f *voiceStateFanout) submit(serverID string, event ws.Event) {
	if f == nil || serverID == "" {
		return
	}
	channelID, snapshot, valid := snapshotVoiceEvent(event)
	if !valid || channelID == "" {
		f.dropCount.Add(1)
		voiceLogger.Warn("voice state fanout rejected event without channel", "server_id", serverID, "op", event.Op)
		return
	}
	snapshot.ServerID = serverID
	item := voiceStateFanoutEvent{serverID: serverID, channelID: channelID, event: snapshot}
	f.mu.Lock()
	if f.stopping {
		f.dropCount.Add(1)
		f.mu.Unlock()
		return
	}
	select {
	case f.queue <- item:
		if !f.worker {
			f.worker = true
			f.workerID++
			workerID := f.workerID
			f.workerWG.Add(1)
			logx.Go("voice-state-fanout", func() { f.run(workerID) })
		}
		f.mu.Unlock()
	default:
		f.dropCount.Add(1)
		f.mu.Unlock()
		voiceLogger.Warn("voice state fanout queue full; event dropped", "server_id", serverID, "channel_id", channelID, "op", event.Op)
	}
}

func (f *voiceStateFanout) run(workerID uint64) {
	defer func() {
		f.mu.Lock()
		if f.workerID == workerID {
			f.worker = false
			// A panic must never strand accepted items behind a dead worker.
			// Since normal idle exit only occurs with an empty queue, pending
			// items here can only be shutdown cancellations or failed work.
			for len(f.queue) > 0 {
				<-f.queue
				f.dropCount.Add(1)
			}
		}
		f.mu.Unlock()
		f.workerWG.Done()
	}()
	timer := time.NewTimer(voiceStateFanoutIdle)
	defer timer.Stop()
	for {
		select {
		case <-f.stop:
			return
		case item := <-f.queue:
			f.mu.Lock()
			stopping := f.stopping
			if stopping {
				f.dropCount.Add(1)
			}
			f.mu.Unlock()
			if stopping {
				return
			}
			f.service.mu.RLock()
			f.service.mu.RUnlock()
			f.deliver(item)
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(voiceStateFanoutIdle)
		case <-timer.C:
			f.mu.Lock()
			if len(f.queue) == 0 || f.stopping {
				f.worker = false
				f.mu.Unlock()
				return
			}
			f.mu.Unlock()
			timer.Reset(voiceStateFanoutIdle)
		}
	}
}

func (f *voiceStateFanout) deliver(item voiceStateFanoutEvent) {
	s := f.service
	provider, ok := s.hub.(ws.UserStateProvider)
	if !ok || provider == nil || s.permResolver == nil {
		f.dropCount.Add(1)
		voiceLogger.Warn("voice state fanout unavailable; event dropped", "server_id", item.serverID, "channel_id", item.channelID)
		return
	}
	if s.channelGetter == nil {
		f.dropCount.Add(1)
		voiceLogger.Warn("voice state fanout channel resolver unavailable; event dropped", "server_id", item.serverID, "channel_id", item.channelID)
		return
	}
	members, ok := s.afkTimeoutGetter.(voiceStateFanoutMembership)
	if !ok || members == nil {
		f.dropCount.Add(1)
		voiceLogger.Warn("voice state fanout membership resolver unavailable; event dropped", "server_id", item.serverID)
		return
	}
	ctx, cancel := context.WithTimeout(f.ctx, broadcastResolveTimeout)
	defer cancel()
	channel, err := s.channelGetter.GetByID(ctx, item.channelID)
	if err != nil || channel == nil || channel.ServerID != item.serverID || channel.Type != models.ChannelTypeVoice {
		f.dropCount.Add(1)
		voiceLogger.Warn("voice state fanout channel scope verification failed; event dropped", "server_id", item.serverID, "channel_id", item.channelID)
		return
	}
	onlineIDs := provider.GetOnlineUserIDsForServer(item.serverID)
	if len(onlineIDs) > voiceStateFanoutMaxOnline {
		f.dropCount.Add(1)
		voiceLogger.Warn("voice state fanout online recipient limit exceeded; event dropped", "server_id", item.serverID, "count", len(onlineIDs))
		return
	}
	if len(onlineIDs) == 0 {
		return
	}
	memberIDs, err := members.ListMemberIDs(ctx, item.serverID)
	if err != nil || len(memberIDs) > voiceStateFanoutMaxMembers {
		f.dropCount.Add(1)
		voiceLogger.Warn("voice state fanout membership resolution failed; event dropped", "server_id", item.serverID)
		return
	}
	memberSet := make(map[string]struct{}, len(memberIDs))
	for _, id := range memberIDs {
		if id != "" {
			memberSet[id] = struct{}{}
		}
	}
	recipients := make([]string, 0, len(onlineIDs))
	seen := make(map[string]struct{}, len(onlineIDs))
	for _, id := range onlineIDs {
		if id == "" {
			continue
		}
		if _, duplicate := seen[id]; duplicate {
			continue
		}
		seen[id] = struct{}{}
		if _, member := memberSet[id]; member {
			recipients = append(recipients, id)
		}
	}
	if len(recipients) == 0 {
		return
	}
	permissions, err := resolveFreshVoiceFanoutPermissions(ctx, s.permResolver, item.channelID, recipients)
	if err != nil {
		f.dropCount.Add(1)
		voiceLogger.Warn("voice state fanout permission resolution failed; event dropped", "server_id", item.serverID, "channel_id", item.channelID)
		return
	}
	visible := recipients[:0]
	for _, id := range recipients {
		perms, found := permissions[id]
		if found && perms.Has(models.PermViewChannel) {
			visible = append(visible, id)
		}
	}
	if len(visible) == 0 {
		return
	}
	item.event.ServerID = item.serverID
	s.hub.BroadcastToUsers(visible, item.event)
}

// Voice presence is private channel metadata. A revocation committed by a
// different app instance cannot invalidate this process's permission cache,
// so this publication boundary must read current role/override rows instead
// of accepting a cached grant for up to permCacheTTL.
func resolveFreshVoiceFanoutPermissions(ctx context.Context, resolver ChannelPermResolver, channelID string, recipients []string) (map[string]models.Permission, error) {
	if cached, ok := resolver.(*cachingPermResolver); ok {
		return cached.inner.ResolveChannelPermissionsBulk(ctx, channelID, recipients)
	}
	return resolver.ResolveChannelPermissionsBulk(ctx, channelID, recipients)
}

func (f *voiceStateFanout) shutdown() {
	if f == nil {
		return
	}
	f.mu.Lock()
	if f.stopping {
		f.mu.Unlock()
		f.workerWG.Wait()
		return
	}
	f.stopping = true
	f.cancel()
	close(f.stop)
	for len(f.queue) > 0 {
		<-f.queue
		f.dropCount.Add(1)
	}
	f.mu.Unlock()
	f.workerWG.Wait()
}

func (f *voiceStateFanout) dropped() uint64 {
	if f == nil {
		return 0
	}
	return f.dropCount.Load()
}
