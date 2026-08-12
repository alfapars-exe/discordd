package services

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/crypto"
	"github.com/argeinfina/hichat/pkg/promparse"
	"github.com/argeinfina/hichat/repository"
	"github.com/hetznercloud/hcloud-go/v2/hcloud"
)

// ActiveVoiceProvider gives access to in-memory voice state (ISP for admin service).
type ActiveVoiceProvider interface {
	GetAllVoiceStates() []models.VoiceState
}

// LiveKitAdminService manages platform-managed LiveKit instances (CRUD).
// Self-hosted instances are out of scope — managed via ServerService.
// Credentials are AES-256-GCM encrypted. Admin views never expose credentials.
type LiveKitAdminService interface {
	ListInstances(ctx context.Context) ([]models.LiveKitInstanceAdminView, error)
	GetInstance(ctx context.Context, instanceID string) (*models.LiveKitInstanceAdminView, error)
	CreateInstance(ctx context.Context, req *models.CreateLiveKitInstanceRequest) (*models.LiveKitInstanceAdminView, error)
	// UpdateInstance updates an instance. Only provided fields are changed.
	// Empty credentials preserve existing values.
	UpdateInstance(ctx context.Context, instanceID string, req *models.UpdateLiveKitInstanceRequest) (*models.LiveKitInstanceAdminView, error)
	// DeleteInstance deletes an instance. If servers are attached, migrates them
	// to targetInstanceID. Errors if targetInstanceID is empty and serverCount > 0.
	DeleteInstance(ctx context.Context, instanceID, targetInstanceID string) error
	ListServers(ctx context.Context) ([]models.AdminServerListItem, error)
	// MigrateServerInstance moves a server to a different LiveKit instance.
	// Target must be platform-managed with available capacity. Self-hosted servers cannot be migrated.
	MigrateServerInstance(ctx context.Context, serverID, newInstanceID string) error
	ListUsers(ctx context.Context) ([]models.AdminUserListItem, error)
	// GetInstanceMetrics fetches real-time metrics from a LiveKit instance's Prometheus endpoint.
	// Returns Available=false if /metrics is unreachable (no error returned).
	GetInstanceMetrics(ctx context.Context, instanceID string) (*models.LiveKitInstanceMetrics, error)

	// GetQuotaReport returns every instance with its current-month usage and
	// derived fields (RemainingMinutes, DaysUntilReset). Self-hosted instances
	// are included with UsedMinutes=0; the UI shows them with an "♾️ unlimited"
	// badge based on IsPlatformManaged.
	GetQuotaReport(ctx context.Context) ([]models.LiveKitInstanceQuotaView, error)

	// UpdateQuotaSettings applies a partial update of the quota-related fields
	// (priority, monthly_quota_minutes, quota_reset_day, auto_switch_enabled,
	// switch_threshold_minutes). Returns the refreshed quota view.
	UpdateQuotaSettings(ctx context.Context, instanceID string, req *models.UpdateLiveKitQuotaSettingsRequest) (*models.LiveKitInstanceQuotaView, error)
}

type livekitAdminService struct {
	livekitRepo   repository.LiveKitRepository
	serverRepo    repository.ServerRepository
	userRepo      repository.UserRepository
	channelRepo   repository.ChannelRepository
	voiceProvider ActiveVoiceProvider
	encryptionKey []byte
	httpClient    *http.Client

	hetznerClient *hcloud.Client // optional (nil = disabled)
	vcpuCache     map[int64]int
}

func NewLiveKitAdminService(
	livekitRepo repository.LiveKitRepository,
	serverRepo repository.ServerRepository,
	userRepo repository.UserRepository,
	channelRepo repository.ChannelRepository,
	voiceProvider ActiveVoiceProvider,
	encryptionKey []byte,
	hetznerToken string,
) LiveKitAdminService {
	svc := &livekitAdminService{
		livekitRepo:   livekitRepo,
		serverRepo:    serverRepo,
		userRepo:      userRepo,
		channelRepo:   channelRepo,
		voiceProvider: voiceProvider,
		encryptionKey: encryptionKey,
		vcpuCache:     make(map[int64]int),
		httpClient: &http.Client{
			Timeout: 5 * time.Second,
			// TLS verification is ON by default. The historical "skip for
			// self-signed certs" mode is gated on LIVEKIT_INSECURE_TLS=true
			// so production installs are safe and self-hosters can still
			// opt in deliberately — see services/tls.go.
			Transport: &http.Transport{
				TLSClientConfig: liveKitTLSConfig(),
			},
		},
	}

	if hetznerToken != "" {
		svc.hetznerClient = hcloud.NewClient(hcloud.WithToken(hetznerToken))
	}

	return svc
}

func (s *livekitAdminService) ListInstances(ctx context.Context) ([]models.LiveKitInstanceAdminView, error) {
	instances, err := s.livekitRepo.ListPlatformInstances(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to list platform instances: %w", err)
	}

	views := make([]models.LiveKitInstanceAdminView, len(instances))
	for i, inst := range instances {
		views[i] = toAdminView(&inst)
	}

	return views, nil
}

func (s *livekitAdminService) GetInstance(ctx context.Context, instanceID string) (*models.LiveKitInstanceAdminView, error) {
	inst, err := s.livekitRepo.GetByID(ctx, instanceID)
	if err != nil {
		return nil, err
	}

	view := toAdminView(inst)
	return &view, nil
}

func (s *livekitAdminService) CreateInstance(ctx context.Context, req *models.CreateLiveKitInstanceRequest) (*models.LiveKitInstanceAdminView, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, pkg.ErrText(err))
	}

	encKey, err := crypto.Encrypt(req.APIKey, s.encryptionKey)
	if err != nil {
		return nil, fmt.Errorf("failed to encrypt api key: %w", err)
	}
	encSecret, err := crypto.Encrypt(req.APISecret, s.encryptionKey)
	if err != nil {
		return nil, fmt.Errorf("failed to encrypt api secret: %w", err)
	}

	// Default to platform-managed (LiveKit Cloud, quota-tracked) when the
	// caller doesn't explicitly opt out. Self-hosted is the alternative
	// the InstanceForm exposes via the "Self-Hosted" toggle.
	isPlatformManaged := true
	if req.IsPlatformManaged != nil {
		isPlatformManaged = *req.IsPlatformManaged
	}

	instance := &models.LiveKitInstance{
		URL:               req.URL,
		APIKey:            encKey,
		APISecret:         encSecret,
		IsPlatformManaged: isPlatformManaged,
		ServerCount:       0,
		MaxServers:        req.MaxServers,
		HetznerServerID:   req.HetznerServerID,
	}

	if err := s.livekitRepo.Create(ctx, instance); err != nil {
		return nil, fmt.Errorf("failed to create livekit instance: %w", err)
	}

	view := toAdminView(instance)
	return &view, nil
}

func (s *livekitAdminService) UpdateInstance(ctx context.Context, instanceID string, req *models.UpdateLiveKitInstanceRequest) (*models.LiveKitInstanceAdminView, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, pkg.ErrText(err))
	}

	inst, err := s.livekitRepo.GetByID(ctx, instanceID)
	if err != nil {
		return nil, err
	}

	// Both platform-managed (LiveKit Cloud) and self-hosted instances are
	// editable through this endpoint. The InstanceForm distinguishes between
	// the two via the IsPlatformManaged toggle; quota-only fields live on
	// the dedicated PATCH /quota endpoint.

	if req.URL != nil {
		inst.URL = *req.URL
	}
	if req.IsPlatformManaged != nil {
		inst.IsPlatformManaged = *req.IsPlatformManaged
	}
	if req.APIKey != nil {
		encKey, encErr := crypto.Encrypt(*req.APIKey, s.encryptionKey)
		if encErr != nil {
			return nil, fmt.Errorf("failed to encrypt api key: %w", encErr)
		}
		inst.APIKey = encKey
	}
	if req.APISecret != nil {
		encSecret, encErr := crypto.Encrypt(*req.APISecret, s.encryptionKey)
		if encErr != nil {
			return nil, fmt.Errorf("failed to encrypt api secret: %w", encErr)
		}
		inst.APISecret = encSecret
	}
	if req.MaxServers != nil {
		inst.MaxServers = *req.MaxServers
	}
	if req.HetznerServerID != nil {
		inst.HetznerServerID = *req.HetznerServerID
	}

	if err := s.livekitRepo.Update(ctx, inst); err != nil {
		return nil, fmt.Errorf("failed to update livekit instance: %w", err)
	}

	view := toAdminView(inst)
	return &view, nil
}

func (s *livekitAdminService) DeleteInstance(ctx context.Context, instanceID, targetInstanceID string) error {
	inst, err := s.livekitRepo.GetByID(ctx, instanceID)
	if err != nil {
		return err
	}

	if !inst.IsPlatformManaged {
		return fmt.Errorf("%w: only platform-managed instances can be deleted via admin API", pkg.ErrForbidden)
	}

	// Migrate attached servers if any
	if inst.ServerCount > 0 {
		if targetInstanceID == "" {
			return fmt.Errorf("%w: instance has %d server(s), specify migrate_to target", pkg.ErrBadRequest, inst.ServerCount)
		}

		if targetInstanceID == instanceID {
			return fmt.Errorf("%w: cannot migrate to the same instance", pkg.ErrBadRequest)
		}

		// Verify the target exists. Self-hosted targets are allowed since v2.11.20 —
		// admins can move servers off a cloud instance onto their own LiveKit.
		if _, targetErr := s.livekitRepo.GetByID(ctx, targetInstanceID); targetErr != nil {
			return fmt.Errorf("migration target not found: %w", targetErr)
		}

		_, migrateErr := s.livekitRepo.MigrateServers(ctx, instanceID, targetInstanceID)
		if migrateErr != nil {
			return fmt.Errorf("failed to migrate servers: %w", migrateErr)
		}
	}

	if err := s.livekitRepo.Delete(ctx, instanceID); err != nil {
		return fmt.Errorf("failed to delete livekit instance: %w", err)
	}

	return nil
}

func (s *livekitAdminService) ListServers(ctx context.Context) ([]models.AdminServerListItem, error) {
	servers, err := s.serverRepo.ListAllWithStats(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to list all servers: %w", err)
	}

	// Cross-reference in-memory voice state to update last_activity for servers
	// with active voice users (DB only records join time, not ongoing sessions)
	activeServerIDs := s.getActiveVoiceServerIDs(ctx)
	if len(activeServerIDs) > 0 {
		now := time.Now().UTC().Format("2006-01-02 15:04:05")
		for i := range servers {
			if activeServerIDs[servers[i].ID] {
				servers[i].LastActivity = &now
			}
		}
	}

	return servers, nil
}

func (s *livekitAdminService) MigrateServerInstance(ctx context.Context, serverID, newInstanceID string) error {
	server, err := s.serverRepo.GetByID(ctx, serverID)
	if err != nil {
		return err
	}

	// Guard: server already on the requested instance.
	if server.LiveKitInstanceID != nil && *server.LiveKitInstanceID == newInstanceID {
		return fmt.Errorf("%w: server is already on this instance", pkg.ErrBadRequest)
	}

	targetInstance, err := s.livekitRepo.GetByID(ctx, newInstanceID)
	if err != nil {
		return fmt.Errorf("target instance not found: %w", err)
	}

	// Self-hosted (is_platform_managed=false) is a valid target since v2.11.20 —
	// admins can manually pin a server to their own LiveKit. Quota tracking and
	// auto-switch automatically skip self-hosted instances elsewhere.

	if targetInstance.MaxServers > 0 && targetInstance.ServerCount >= targetInstance.MaxServers {
		return fmt.Errorf("%w: target instance is at capacity (%d/%d)", pkg.ErrBadRequest,
			targetInstance.ServerCount, targetInstance.MaxServers)
	}

	if err := s.livekitRepo.MigrateOneServer(ctx, serverID, newInstanceID); err != nil {
		return fmt.Errorf("failed to migrate server instance: %w", err)
	}

	return nil
}

func (s *livekitAdminService) ListUsers(ctx context.Context) ([]models.AdminUserListItem, error) {
	users, err := s.userRepo.ListAllUsersWithStats(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to list all users: %w", err)
	}

	// Update last_activity for users currently in voice channels
	activeUserIDs := s.getActiveVoiceUserIDs()
	if len(activeUserIDs) > 0 {
		now := time.Now().UTC().Format("2006-01-02 15:04:05")
		for i := range users {
			if activeUserIDs[users[i].ID] {
				users[i].LastActivity = &now
			}
		}
	}

	return users, nil
}

// getActiveVoiceServerIDs resolves which servers have active voice users.
// VoiceState only holds channelID — uses channelRepo for channel->server lookup.
func (s *livekitAdminService) getActiveVoiceServerIDs(ctx context.Context) map[string]bool {
	states := s.voiceProvider.GetAllVoiceStates()
	if len(states) == 0 {
		return nil
	}

	channelIDs := make(map[string]struct{})
	for _, st := range states {
		channelIDs[st.ChannelID] = struct{}{}
	}

	serverIDs := make(map[string]bool)
	for chID := range channelIDs {
		ch, err := s.channelRepo.GetByID(ctx, chID)
		if err != nil {
			continue // channel may have been deleted
		}
		serverIDs[ch.ServerID] = true
	}

	return serverIDs
}

func (s *livekitAdminService) getActiveVoiceUserIDs() map[string]bool {
	states := s.voiceProvider.GetAllVoiceStates()
	if len(states) == 0 {
		return nil
	}

	userIDs := make(map[string]bool, len(states))
	for _, st := range states {
		userIDs[st.UserID] = true
	}
	return userIDs
}

func (s *livekitAdminService) GetInstanceMetrics(ctx context.Context, instanceID string) (*models.LiveKitInstanceMetrics, error) {
	inst, err := s.livekitRepo.GetByID(ctx, instanceID)
	if err != nil {
		return nil, err
	}

	result := &models.LiveKitInstanceMetrics{
		FetchedAt: time.Now().UTC(),
	}

	// LiveKit /metrics — rooms, participants, memory, goroutines
	metricsURL := LiveKitURLToMetrics(inst.URL)
	req, reqErr := http.NewRequestWithContext(ctx, http.MethodGet, metricsURL, nil)
	if reqErr == nil {
		resp, httpErr := s.httpClient.Do(req)
		if httpErr == nil {
			defer func() { _ = resp.Body.Close() }() // read-side handle — nothing buffered to flush, safe to ignore
			if resp.StatusCode == http.StatusOK {
				body, readErr := io.ReadAll(io.LimitReader(resp.Body, 5*1024*1024))
				if readErr == nil {
					m := promparse.Parse(string(body))
					result.Goroutines = m.Int("go_goroutines")
					result.MemoryUsed = m.Uint64("process_resident_memory_bytes")
					result.RoomCount = m.Int("livekit_room_total")
					result.ParticipantCount = m.Int("livekit_participant_total")
					result.TrackPublishCount = m.SumInt("livekit_track_published_total")
					result.TrackSubscribeCount = m.SumInt("livekit_track_subscribed_total")
					result.BytesIn = m.Uint64WithLabel("livekit_packet_bytes", "direction", "incoming")
					result.BytesOut = m.Uint64WithLabel("livekit_packet_bytes", "direction", "outgoing")
					result.PacketsIn = m.Uint64WithLabel("livekit_packet_total", "direction", "incoming")
					result.PacketsOut = m.Uint64WithLabel("livekit_packet_total", "direction", "outgoing")
					result.NackTotal = m.SumUint64("livekit_nack_total")
					result.Available = true
				}
			}
		}
	}

	// Hetzner Cloud API — CPU and bandwidth (independent source)
	if inst.HetznerServerID != "" && s.hetznerClient != nil {
		cpuPct, bwIn, bwOut, hErr := s.fetchHetznerMetricsRT(ctx, inst.HetznerServerID)
		if hErr == nil {
			result.CPUPercent = cpuPct
			result.BandwidthInBps = bwIn
			result.BandwidthOutBps = bwOut
			result.HetznerAvail = true
			result.Available = true
		}
	}

	return result, nil
}

// LiveKitURLToMetrics converts a LiveKit WebSocket URL to its Prometheus /metrics HTTP URL.
//
//	wss://livekit.example.com -> https://livekit.example.com/metrics
//	ws://localhost:7880 -> http://localhost:7880/metrics
func LiveKitURLToMetrics(rawURL string) string {
	u := rawURL

	if strings.HasPrefix(u, "wss://") {
		u = "https://" + strings.TrimPrefix(u, "wss://")
	} else if strings.HasPrefix(u, "ws://") {
		u = "http://" + strings.TrimPrefix(u, "ws://")
	}

	u = strings.TrimRight(u, "/")

	return u + "/metrics"
}

// fetchHetznerMetricsRT fetches real-time Hetzner metrics for the admin panel.
func (s *livekitAdminService) fetchHetznerMetricsRT(ctx context.Context, hetznerServerIDStr string) (cpuPct, bwIn, bwOut float64, err error) {
	serverID, err := strconv.ParseInt(hetznerServerIDStr, 10, 64)
	if err != nil {
		return 0, 0, 0, err
	}

	// vCPU count — from cache or API
	vcpuCount := 1
	if cached, ok := s.vcpuCache[serverID]; ok {
		vcpuCount = cached
	} else {
		server, _, srvErr := s.hetznerClient.Server.GetByID(ctx, serverID)
		if srvErr != nil {
			return 0, 0, 0, srvErr
		}
		if server != nil && server.ServerType != nil && server.ServerType.Cores > 0 {
			vcpuCount = server.ServerType.Cores
		}
		s.vcpuCache[serverID] = vcpuCount
	}

	// Last 5 minutes window
	now := time.Now().UTC()
	start := now.Add(-5 * time.Minute)
	result, _, apiErr := s.hetznerClient.Server.GetMetrics(ctx, &hcloud.Server{ID: serverID}, hcloud.ServerGetMetricsOpts{
		Types: []hcloud.ServerMetricType{
			hcloud.ServerMetricCPU,
			hcloud.ServerMetricNetwork,
		},
		Start: start,
		End:   now,
	})
	if apiErr != nil {
		return 0, 0, 0, apiErr
	}

	if cpuValues, ok := result.TimeSeries["cpu"]; ok && len(cpuValues) > 0 {
		rawCPU, parseErr := strconv.ParseFloat(cpuValues[len(cpuValues)-1].Value, 64)
		if parseErr == nil && vcpuCount > 0 {
			cpuPct = rawCPU / float64(vcpuCount)
		}
	}
	if inValues, ok := result.TimeSeries["network.0.bandwidth.in"]; ok && len(inValues) > 0 {
		parsed, parseErr := strconv.ParseFloat(inValues[len(inValues)-1].Value, 64)
		if parseErr == nil {
			bwIn = parsed
		}
	}
	if outValues, ok := result.TimeSeries["network.0.bandwidth.out"]; ok && len(outValues) > 0 {
		parsed, parseErr := strconv.ParseFloat(outValues[len(outValues)-1].Value, 64)
		if parseErr == nil {
			bwOut = parsed
		}
	}

	return cpuPct, bwIn, bwOut, nil
}

// toAdminView converts a LiveKitInstance to a credential-free admin view.
func toAdminView(inst *models.LiveKitInstance) models.LiveKitInstanceAdminView {
	return models.LiveKitInstanceAdminView{
		ID:                     inst.ID,
		URL:                    inst.URL,
		IsPlatformManaged:      inst.IsPlatformManaged,
		ServerCount:            inst.ServerCount,
		MaxServers:             inst.MaxServers,
		HetznerServerID:        inst.HetznerServerID,
		CreatedAt:              inst.CreatedAt,
		Priority:               inst.Priority,
		MonthlyQuotaMinutes:    inst.MonthlyQuotaMinutes,
		QuotaResetDay:          inst.QuotaResetDay,
		AutoSwitchEnabled:      inst.AutoSwitchEnabled,
		SwitchThresholdMinutes: inst.SwitchThresholdMinutes,
	}
}

// GetQuotaReport assembles the rows the admin "LiveKit Kota" page renders.
// Pulls all instances in one query (ListInstancesWithQuota), then computes
// per-row derived fields locally so the SQL stays simple.
func (s *livekitAdminService) GetQuotaReport(ctx context.Context) ([]models.LiveKitInstanceQuotaView, error) {
	now := time.Now()
	year, month, _ := now.Date()
	instances, usedSeconds, err := s.livekitRepo.ListInstancesWithQuota(ctx, year, int(month))
	if err != nil {
		return nil, fmt.Errorf("failed to list instances with quota: %w", err)
	}
	out := make([]models.LiveKitInstanceQuotaView, len(instances))
	for i := range instances {
		inst := &instances[i]
		view := models.LiveKitInstanceQuotaView{
			LiveKitInstanceAdminView: toAdminView(inst),
		}
		if inst.IsPlatformManaged {
			view.UsedMinutes = int(usedSeconds[i] / 60)
			view.RemainingMinutes = inst.MonthlyQuotaMinutes - view.UsedMinutes
			if view.RemainingMinutes < 0 {
				view.RemainingMinutes = 0
			}
			view.DaysUntilReset = daysUntilNextReset(now, inst.QuotaResetDay)
		}
		// Self-hosted: UsedMinutes=0, RemainingMinutes=0, DaysUntilReset=0;
		// UI hides those columns for is_platform_managed=false rows.
		out[i] = view
	}
	return out, nil
}

// UpdateQuotaSettings validates and applies a partial quota-fields update,
// then re-fetches and returns the refreshed view so the UI doesn't have to
// race with a follow-up GET.
func (s *livekitAdminService) UpdateQuotaSettings(
	ctx context.Context, instanceID string, req *models.UpdateLiveKitQuotaSettingsRequest,
) (*models.LiveKitInstanceQuotaView, error) {
	if req == nil {
		return nil, fmt.Errorf("%w: request is required", pkg.ErrBadRequest)
	}
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, pkg.ErrText(err))
	}
	if err := s.livekitRepo.UpdateQuotaSettings(ctx, instanceID, req); err != nil {
		return nil, err
	}
	// Refresh the quota view by reading just this instance back through the
	// joined query — keeps DaysUntilReset / RemainingMinutes consistent.
	now := time.Now()
	year, month, _ := now.Date()
	instances, usedSeconds, err := s.livekitRepo.ListInstancesWithQuota(ctx, year, int(month))
	if err != nil {
		return nil, fmt.Errorf("failed to refresh quota view: %w", err)
	}
	for i := range instances {
		if instances[i].ID != instanceID {
			continue
		}
		inst := &instances[i]
		view := models.LiveKitInstanceQuotaView{
			LiveKitInstanceAdminView: toAdminView(inst),
		}
		if inst.IsPlatformManaged {
			view.UsedMinutes = int(usedSeconds[i] / 60)
			view.RemainingMinutes = inst.MonthlyQuotaMinutes - view.UsedMinutes
			if view.RemainingMinutes < 0 {
				view.RemainingMinutes = 0
			}
			view.DaysUntilReset = daysUntilNextReset(now, inst.QuotaResetDay)
		}
		return &view, nil
	}
	return nil, pkg.ErrNotFound
}

// daysUntilNextReset returns the calendar-day count from `today` to the next
// occurrence of `resetDay`. Same-day = 0 (will reset at end of today). Wraps
// to next month when resetDay has already passed this month.
func daysUntilNextReset(today time.Time, resetDay int) int {
	if resetDay < 1 {
		resetDay = 1
	}
	if resetDay > 28 {
		resetDay = 28 // matches the validator cap; never special-case Feb
	}
	year, month, day := today.Date()
	if resetDay >= day {
		return resetDay - day
	}
	// Reset day has passed for this month — count to next month's reset day.
	nextMonth := today.AddDate(0, 1, 0)
	ny, nm, _ := nextMonth.Date()
	target := time.Date(ny, nm, resetDay, 0, 0, 0, 0, today.Location())
	cur := time.Date(year, month, day, 0, 0, 0, 0, today.Location())
	return int(target.Sub(cur).Hours() / 24)
}
