// Package services — server service core: type definitions, constructor, and shared audit helper.
package services

import (
	"context"
	"database/sql"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

var serverLogger = logx.Component("service.server")

type ServerService interface {
	CreateServer(ctx context.Context, ownerID string, req *models.CreateServerRequest) (*models.Server, error)
	GetServer(ctx context.Context, serverID string) (*models.Server, error)
	GetUserServers(ctx context.Context, userID string) ([]models.ServerListItem, error)
	UpdateServer(ctx context.Context, serverID string, req *models.UpdateServerRequest) (*models.Server, error)
	UpdateIcon(ctx context.Context, serverID, iconURL string) (*models.Server, error)
	DeleteServer(ctx context.Context, serverID, userID string) error
	JoinServer(ctx context.Context, userID, inviteCode string) (*models.Server, error)
	LeaveServer(ctx context.Context, serverID, userID string) error
	GetLiveKitSettings(ctx context.Context, serverID string) (*LiveKitSettings, error)
	// ReorderServers updates the user's personal server list order. No WS broadcast.
	ReorderServers(ctx context.Context, userID string, req *models.ReorderServersRequest) ([]models.ServerListItem, error)
	SetUploadDir(dir string)
}

type serverService struct {
	db                 *sql.DB // for WithTx in CreateServer/DeleteServer
	serverRepo         repository.ServerRepository
	livekitRepo        repository.LiveKitRepository
	roleRepo           repository.RoleRepository
	channelRepo        repository.ChannelRepository
	categoryRepo       repository.CategoryRepository
	userRepo           repository.UserRepository
	banRepo            repository.BanRepository // N-02: JoinServer's ban gate
	inviteService      InviteService
	hub                ws.BroadcastAndManage
	encryptionKey      []byte // AES-256-GCM for LiveKit credentials
	auditLogger        AuditWriter
	// membershipTxRunner backs JoinServer's atomic AddMember+AssignToUser
	// (server_service_membership.go). A separate mockable seam from the raw
	// `db` field above (rather than another database.WithTx(s.db, ...) call
	// like CreateServer/DeleteServer use) so the existing mock-based
	// JoinServer tests keep working without a real *sql.DB.
	membershipTxRunner repository.ServerMembershipTxRunner
	// uploadDir enables best-effort disk cleanup on server delete (see
	// upload_cleanup.go). Blank disables cleanup — set via SetUploadDir,
	// wired in init_services.go so the constructor signature below stays
	// unchanged.
	uploadDir string
}

func (s *serverService) SetUploadDir(dir string) {
	s.uploadDir = dir
}

// audit emits an audit log event if an audit logger is wired. Nil-safe.
// Same observability pattern as member/role/voice/channel: both branches
// log so a "user X joined/left but audit channel stayed empty" report
// can be traced from runtime logs.
func (s *serverService) audit(entry models.AuditLog) {
	if s.auditLogger == nil {
		serverLogger.Warn("audit event dropped, auditLogger not wired", "event_type", entry.EventType, "server_id", entry.ServerID)
		return
	}
	serverLogger.Info("audit event emitted", "event_type", entry.EventType, "server_id", entry.ServerID)
	s.auditLogger.Write(entry)
}

func NewServerService(
	db *sql.DB,
	serverRepo repository.ServerRepository,
	livekitRepo repository.LiveKitRepository,
	roleRepo repository.RoleRepository,
	channelRepo repository.ChannelRepository,
	categoryRepo repository.CategoryRepository,
	userRepo repository.UserRepository,
	banRepo repository.BanRepository,
	inviteService InviteService,
	hub ws.BroadcastAndManage,
	encryptionKey []byte,
	auditLogger AuditWriter,
	membershipTxRunner repository.ServerMembershipTxRunner,
) ServerService {
	return &serverService{
		db:                 db,
		serverRepo:         serverRepo,
		livekitRepo:        livekitRepo,
		roleRepo:           roleRepo,
		channelRepo:        channelRepo,
		categoryRepo:       categoryRepo,
		userRepo:           userRepo,
		banRepo:            banRepo,
		inviteService:      inviteService,
		hub:                hub,
		encryptionKey:      encryptionKey,
		auditLogger:        auditLogger,
		membershipTxRunner: membershipTxRunner,
	}
}
