// Package services - cosmetic_service.go: profile cosmetics (Faz G1).
//
// Equipping is self-scoped: a user equips one item per (scope, slot type),
// scope "global" or a server they are a member of. The item's canonical
// asset is snapshotted into the equipped row. One request changes 1-5 slots
// in one transaction and yields at most one WS event per affected context
// (coalesced); a request that changes nothing broadcasts nothing.
package services

import (
	"context"
	"errors"
	"fmt"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

var cosmeticLogger = logx.Component("service.cosmetic")

// CosmeticServerRepo is the slice of repository.ServerRepository the
// cosmetic service needs.
type CosmeticServerRepo interface {
	IsMember(ctx context.Context, serverID, userID string) (bool, error)
	GetUserServers(ctx context.Context, userID string) ([]models.ServerListItem, error)
}

// CosmeticService is the cosmetics surface.
type CosmeticService interface {
	// GetMine returns the caller's wearable catalog, grants, raw equipped
	// slots per scope and plain servers.
	GetMine(ctx context.Context, userID string) (*models.MyCosmetics, error)
	// Equip applies req and returns GetMine. A missing item and a scope
	// server the caller is not a member of are the same
	// models.ErrCosmeticNotFound (no membership oracle).
	Equip(ctx context.Context, userID string, req *models.EquipRequest) (*models.MyCosmetics, error)
	// SetPlainServer switches "look plain in serverID" for the caller.
	SetPlainServer(ctx context.Context, userID, serverID string, plain bool) error
	// LookupGlobal returns the global slots of ids (1-100 well-formed ids,
	// duplicates collapsed); users without any slot are left out.
	LookupGlobal(ctx context.Context, ids []string) (*models.CosmeticsLookupResponse, error)
	// ServerCosmetics returns the resolved slots of serverID's members.
	// Membership of the caller is checked by the route (authServer).
	ServerCosmetics(ctx context.Context, serverID string) (*models.ServerCosmeticsResponse, error)
}

type cosmeticService struct {
	repo    repository.CosmeticRepository
	servers CosmeticServerRepo
	ent     CosmeticEntitlements
	hub     ws.Broadcaster
}

func NewCosmeticService(
	repo repository.CosmeticRepository,
	servers CosmeticServerRepo,
	ent CosmeticEntitlements,
	hub ws.Broadcaster,
) CosmeticService {
	return &cosmeticService{repo: repo, servers: servers, ent: ent, hub: hub}
}

func (s *cosmeticService) GetMine(ctx context.Context, userID string) (*models.MyCosmetics, error) {
	builtin, err := s.repo.ListBuiltinItems(ctx)
	if err != nil {
		return nil, fmt.Errorf("list builtin cosmetics: %w", err)
	}
	serverItems, err := s.repo.ListEquippableServerItems(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list server cosmetics: %w", err)
	}
	items := make([]models.CosmeticItem, 0, len(builtin)+len(serverItems))
	for _, list := range [][]models.CosmeticItem{builtin, serverItems} {
		for i := range list {
			asset, err := list[i].CanonicalAsset()
			if err != nil {
				// A stored item that no longer validates is left out, not
				// served raw.
				cosmeticLogger.Warn("skipping invalid cosmetic item", "item_id", list[i].ID)
				continue
			}
			list[i].Asset = asset
			items = append(items, list[i])
		}
	}

	grants, err := s.repo.ListGrants(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list cosmetic grants: %w", err)
	}
	if grants == nil {
		grants = []models.CosmeticGrant{}
	}

	rows, err := s.repo.ListEquipped(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list equipped cosmetics: %w", err)
	}
	equipped := models.MyEquipped{
		Global:  models.CosmeticScopeSlots(rows, ""),
		Servers: map[string]models.CosmeticSlots{},
	}
	for _, r := range rows {
		if r.ScopeServerID == "" {
			continue
		}
		if _, done := equipped.Servers[r.ScopeServerID]; done {
			continue
		}
		if slots := models.CosmeticScopeSlots(rows, r.ScopeServerID); len(slots) > 0 {
			equipped.Servers[r.ScopeServerID] = slots
		}
	}

	plain, err := s.repo.ListPlainServers(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list plain servers: %w", err)
	}
	if plain == nil {
		plain = []string{}
	}

	return &models.MyCosmetics{Items: items, Grants: grants, Equipped: equipped, PlainServerIDs: plain}, nil
}

func (s *cosmeticService) Equip(ctx context.Context, userID string, req *models.EquipRequest) (*models.MyCosmetics, error) {
	if req == nil {
		return nil, models.ErrCosmeticSlotsInvalid
	}
	if err := req.Validate(); err != nil {
		return nil, err
	}
	scopeID := ""
	if req.Scope != models.CosmeticScopeGlobal {
		scopeID = req.Scope
		if err := s.requireMember(ctx, scopeID, userID); err != nil {
			return nil, err
		}
	}

	set := map[string]models.CosmeticEquipRow{}
	var unset []string
	// Fixed type order so the first failing slot is deterministic.
	for _, typ := range models.CosmeticTypes {
		id, present := req.Slots[typ]
		if !present {
			continue
		}
		if id == nil {
			unset = append(unset, typ)
			continue
		}
		row, err := s.equipRow(ctx, userID, scopeID, typ, *id)
		if err != nil {
			return nil, err
		}
		set[typ] = row
	}

	changed, err := s.repo.ApplyEquip(ctx, userID, scopeID, set, unset)
	if err != nil {
		return nil, fmt.Errorf("apply equip: %w", err)
	}
	if changed {
		s.broadcastEquip(userID, scopeID)
	}
	return s.GetMine(ctx, userID)
}

// equipRow runs the per-slot checks - item exists, fits the slot, belongs
// to the scope, is wearable - and builds the snapshot row.
func (s *cosmeticService) equipRow(ctx context.Context, userID, scopeID, typ, itemID string) (models.CosmeticEquipRow, error) {
	item, err := s.repo.GetItem(ctx, itemID)
	if err != nil {
		if errors.Is(err, pkg.ErrNotFound) {
			return models.CosmeticEquipRow{}, models.ErrCosmeticNotFound
		}
		return models.CosmeticEquipRow{}, fmt.Errorf("get cosmetic item: %w", err)
	}
	if item.Type != typ {
		return models.CosmeticEquipRow{}, models.ErrCosmeticSlotMismatch
	}
	if item.ServerID != nil && *item.ServerID != scopeID {
		return models.CosmeticEquipRow{}, models.ErrCosmeticScopeMismatch
	}
	ok, err := s.ent.CanWear(ctx, userID, item)
	if err != nil {
		return models.CosmeticEquipRow{}, fmt.Errorf("check cosmetic entitlement: %w", err)
	}
	if !ok {
		return models.CosmeticEquipRow{}, models.ErrCosmeticNotOwned
	}
	asset, err := item.CanonicalAsset()
	if err != nil {
		// Stored data that no longer validates is a server fault, not the
		// caller's (no %w: keeps the 400 sentinel out of the chain).
		return models.CosmeticEquipRow{}, fmt.Errorf("stored cosmetic item %s has an invalid asset", item.ID)
	}
	return models.CosmeticEquipRow{
		ItemID:        item.ID,
		Format:        item.Format,
		Animated:      item.Animated,
		AssetSnapshot: string(asset),
	}, nil
}

func (s *cosmeticService) SetPlainServer(ctx context.Context, userID, serverID string, plain bool) error {
	if !models.ValidCosmeticID(serverID) {
		return models.ErrCosmeticNotFound
	}
	if err := s.requireMember(ctx, serverID, userID); err != nil {
		return err
	}
	changed, err := s.repo.SetPlainServer(ctx, userID, serverID, plain)
	if err != nil {
		return fmt.Errorf("set plain server: %w", err)
	}
	if changed {
		bctx, cancel := BroadcastContext()
		defer cancel()
		s.broadcastServer(bctx, userID, serverID)
	}
	return nil
}

func (s *cosmeticService) LookupGlobal(ctx context.Context, ids []string) (*models.CosmeticsLookupResponse, error) {
	seen := make(map[string]bool, len(ids))
	unique := make([]string, 0, len(ids))
	for _, id := range ids {
		if !models.ValidCosmeticID(id) {
			return nil, models.ErrCosmeticIDsInvalid
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		unique = append(unique, id)
	}
	if len(unique) == 0 || len(unique) > models.CosmeticLookupMaxIDs {
		return nil, models.ErrCosmeticIDsInvalid
	}
	users, err := s.repo.GlobalSlotsForUsers(ctx, unique)
	if err != nil {
		return nil, fmt.Errorf("lookup global cosmetics: %w", err)
	}
	if users == nil {
		users = map[string]models.CosmeticSlots{}
	}
	return &models.CosmeticsLookupResponse{Users: users}, nil
}

func (s *cosmeticService) ServerCosmetics(ctx context.Context, serverID string) (*models.ServerCosmeticsResponse, error) {
	users, err := s.repo.ServerSlots(ctx, serverID)
	if err != nil {
		return nil, fmt.Errorf("list server cosmetics: %w", err)
	}
	if users == nil {
		users = map[string]models.CosmeticSlots{}
	}
	return &models.ServerCosmeticsResponse{ServerID: serverID, Users: users}, nil
}

// requireMember returns models.ErrCosmeticNotFound when userID is not a
// member of serverID - the same error as a missing item.
func (s *cosmeticService) requireMember(ctx context.Context, serverID, userID string) error {
	ok, err := s.servers.IsMember(ctx, serverID, userID)
	if err != nil {
		return fmt.Errorf("check server membership: %w", err)
	}
	if !ok {
		return models.ErrCosmeticNotFound
	}
	return nil
}

// broadcastEquip fans out one user_cosmetics_update per affected context
// after a committed change. A server-scope change affects only that
// server. A global change affects the caller's global view (sent to the
// caller, server_id null) and every server they are in (resolved for it).
// Runs on its own bounded context: the request may already be cancelled.
func (s *cosmeticService) broadcastEquip(userID, scopeID string) {
	ctx, cancel := BroadcastContext()
	defer cancel()

	if scopeID != "" {
		s.broadcastServer(ctx, userID, scopeID)
		return
	}

	rows, err := s.repo.ListEquipped(ctx, userID)
	if err != nil {
		cosmeticLogger.Warn("cosmetics broadcast: list equipped failed", "user_id", userID, "err", pkg.ErrText(err))
		return
	}
	s.hub.BroadcastToUser(userID, ws.Event{
		Op: ws.OpUserCosmeticsUpdate,
		Data: models.CosmeticsUpdateEvent{
			UserID: userID,
			Slots:  models.CosmeticScopeSlots(rows, ""),
		},
	})

	servers, err := s.servers.GetUserServers(ctx, userID)
	if err != nil {
		cosmeticLogger.Warn("cosmetics broadcast: list servers failed", "user_id", userID, "err", pkg.ErrText(err))
		return
	}
	for _, srv := range servers {
		s.broadcastServer(ctx, userID, srv.ID)
	}
}

// broadcastServer sends userID's slots resolved for serverID to serverID.
func (s *cosmeticService) broadcastServer(ctx context.Context, userID, serverID string) {
	slots, plain, err := s.repo.SlotsForUserInServer(ctx, userID, serverID)
	if err != nil {
		cosmeticLogger.Warn("cosmetics broadcast: resolve slots failed",
			"user_id", userID, "server_id", serverID, "err", pkg.ErrText(err))
		return
	}
	if plain || slots == nil {
		slots = models.CosmeticSlots{}
	}
	sid := serverID
	s.hub.BroadcastToServer(serverID, ws.Event{
		Op: ws.OpUserCosmeticsUpdate,
		Data: models.CosmeticsUpdateEvent{
			UserID:   userID,
			ServerID: &sid,
			Slots:    slots,
			Plain:    plain,
		},
	})
}
