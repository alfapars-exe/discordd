// Package models - cosmetics.go: profile cosmetics (migration 089).
//
// Five slot types - avatar frame, nameplate, name style, profile theme,
// profile effect. Built-in items (server_id NULL) are first-party: frames
// are client-bundled SVG components keyed by an enum, everything else is a
// small structured token document. The server never stores or serves SVG
// bytes or raw CSS - every asset is validated against a strict schema and
// re-serialized canonically (ValidateCosmeticAsset). Raster frames (Faz G2)
// are built by the server only (BuildRasterFrameAsset).
//
// A user equips one item per (scope, type): the empty scope is global, a server id
// overrides it inside that server. The item's canonical asset is copied
// into the equipped row at equip time (snapshot).
package models

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"

	"github.com/argeinfina/hichat/pkg"
)

// Slot types, in their fixed display order.
const (
	CosmeticTypeAvatarFrame   = "avatar_frame"
	CosmeticTypeNameplate     = "nameplate"
	CosmeticTypeNameStyle     = "name_style"
	CosmeticTypeProfileTheme  = "profile_theme"
	CosmeticTypeProfileEffect = "profile_effect"
)

// Asset formats.
const (
	CosmeticFormatSVG    = "svg"
	CosmeticFormatCSS    = "css"
	CosmeticFormatRaster = "raster"
)

// Item availability.
const (
	CosmeticAvailabilityFree    = "free"
	CosmeticAvailabilityGranted = "granted"
)

const (
	// CosmeticScopeGlobal is the API spelling of the global scope (stored
	// as scope_server_id = '').
	CosmeticScopeGlobal = "global"
	// CosmeticAssetMaxBytes caps a raw asset JSON document.
	CosmeticAssetMaxBytes = 512
	// CosmeticLookupMaxIDs caps GET /api/users/cosmetics?ids=.
	CosmeticLookupMaxIDs = 100
	// CosmeticContrastMin is the WCAG ratio every name-style sample must
	// reach against CosmeticContrastReference.
	CosmeticContrastMin = 4.5
	// CosmeticContrastReference is the lightest dark-theme background.
	CosmeticContrastReference = "#3b4252"
	// MaxServerCosmeticItems caps server-made items (Faz G2).
	MaxServerCosmeticItems = 50
	// CosmeticNameMaxRunes / CosmeticDescriptionMaxRunes /
	// CosmeticReasonMaxRunes bound server-made item text (Faz G2).
	CosmeticNameMaxRunes        = 32
	CosmeticDescriptionMaxRunes = 100
	CosmeticReasonMaxRunes      = 100
)

// CosmeticTypes lists every slot type in display order.
var CosmeticTypes = []string{
	CosmeticTypeAvatarFrame,
	CosmeticTypeNameplate,
	CosmeticTypeNameStyle,
	CosmeticTypeProfileTheme,
	CosmeticTypeProfileEffect,
}

var (
	cosmeticFrameKeys = map[string]bool{
		"aurora": true, "ember": true, "frost": true, "sakura": true, "circuit": true, "laurel": true,
	}
	cosmeticNameplatePatterns = map[string]bool{"none": true, "dots": true, "stripes": true, "grain": true}
	cosmeticNameFonts         = map[string]bool{"default": true, "bold": true, "mono": true}
	cosmeticEffects           = map[string]bool{
		"sparkle": true, "snow": true, "glow": true, "petals": true, "confetti": true, "stars": true,
	}
	cosmeticHexPattern = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
	// cosmeticIDPattern bounds scope ids, item ids and looked-up user ids.
	cosmeticIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

	// CosmeticRasterURLPattern / CosmeticRasterAnimatedURLPattern are the
	// exact shapes of server-written raster frame files (trap #247).
	CosmeticRasterURLPattern         = regexp.MustCompile(`^/api/uploads/cosmetics/[a-f0-9]{16}\.png$`)
	CosmeticRasterAnimatedURLPattern = regexp.MustCompile(`^/api/uploads/cosmetics/[a-f0-9]{16}\.gif$`)
)

// Cosmetic errors. Messages are fixed literals (CWE-209); each wraps the
// pkg sentinel that decides its HTTP status, and the handler attaches the
// matching COSMETIC_* code.
var (
	ErrCosmeticSlotsInvalid   = fmt.Errorf("%w: invalid cosmetic slots", pkg.ErrBadRequest)
	ErrCosmeticSlotMismatch   = fmt.Errorf("%w: cosmetic item does not fit this slot", pkg.ErrBadRequest)
	ErrCosmeticScopeMismatch  = fmt.Errorf("%w: a server cosmetic can only be worn on its own server", pkg.ErrBadRequest)
	ErrCosmeticNotOwned       = fmt.Errorf("%w: you do not own this cosmetic", pkg.ErrForbidden)
	ErrCosmeticIDsInvalid     = fmt.Errorf("%w: invalid user id list", pkg.ErrBadRequest)
	ErrCosmeticAssetInvalid   = fmt.Errorf("%w: invalid cosmetic asset", pkg.ErrBadRequest)
	ErrCosmeticRequestInvalid = fmt.Errorf("%w: invalid request body", pkg.ErrBadRequest)
	// ErrCosmeticItemNotFound is the repository's own not-found (trap #248).
	ErrCosmeticItemNotFound = fmt.Errorf("%w: cosmetic item not found", pkg.ErrNotFound)
	// ErrCosmeticNotFound is what the service returns for both a missing
	// item and a scope server the caller is not a member of - one message,
	// so the response is no membership oracle.
	ErrCosmeticNotFound = fmt.Errorf("%w: not found", pkg.ErrNotFound)

	errCosmeticAssetShape = errors.New("cosmetic asset shape")
)

// CosmeticItem is one catalog item. Asset is the canonical asset document
// (filled by the service, never the raw column). AssetJSON, FileURL,
// AnimatedURL, CreatedBy and SortOrder are storage-only.
type CosmeticItem struct {
	ID           string          `json:"id"`
	ServerID     *string         `json:"server_id"`
	Type         string          `json:"type"`
	Format       string          `json:"format"`
	Name         string          `json:"name"`
	Description  *string         `json:"description"`
	Asset        json.RawMessage `json:"asset"`
	Animated     bool            `json:"animated"`
	Availability string          `json:"availability"`
	CreatedAt    string          `json:"created_at"` // RFC3339 UTC

	AssetJSON   *string `json:"-"`
	FileURL     *string `json:"-"`
	AnimatedURL *string `json:"-"`
	CreatedBy   *string `json:"-"`
	SortOrder   int     `json:"-"`
}

// CanonicalAsset returns the item's canonical asset document: rebuilt from
// the file URLs for a raster frame, re-validated from asset_json otherwise.
func (it *CosmeticItem) CanonicalAsset() ([]byte, error) {
	if it.Format == CosmeticFormatRaster {
		if it.Type != CosmeticTypeAvatarFrame || it.FileURL == nil {
			return nil, ErrCosmeticAssetInvalid
		}
		animated := ""
		if it.AnimatedURL != nil {
			animated = *it.AnimatedURL
		}
		return BuildRasterFrameAsset(*it.FileURL, animated)
	}
	if it.AssetJSON == nil {
		return nil, ErrCosmeticAssetInvalid
	}
	return ValidateCosmeticAsset(it.Type, it.Format, []byte(*it.AssetJSON))
}

// EquippedCosmetic is one filled slot as the API returns it (from the
// equip-time snapshot).
type EquippedCosmetic struct {
	ItemID   string          `json:"item_id"`
	Format   string          `json:"format"`
	Animated bool            `json:"animated"`
	Asset    json.RawMessage `json:"asset"`
}

// CosmeticSlots maps a slot type to its equipped item. Only filled slots
// are present; a nil map serializes as {} (never null).
type CosmeticSlots map[string]EquippedCosmetic

// MarshalJSON writes {} for a nil map.
func (s CosmeticSlots) MarshalJSON() ([]byte, error) {
	if s == nil {
		return []byte("{}"), nil
	}
	return json.Marshal(map[string]EquippedCosmetic(s))
}

// CosmeticEquipRow is what ApplyEquip writes into one slot.
type CosmeticEquipRow struct {
	ItemID        string
	Format        string
	Animated      bool
	AssetSnapshot string // canonical asset JSON
}

// CosmeticEquippedRow is the storage shape of one user_equipped row plus
// the equipped item's server_id (joined), used to drop a row that points at
// a server item outside its scope.
type CosmeticEquippedRow struct {
	UserID        string
	ScopeServerID string // '' = global
	Type          string
	ItemID        string
	Format        string
	Animated      bool
	AssetSnapshot string
	EquippedAt    string // RFC3339 UTC
	ItemServerID  *string
}

// CosmeticGrantUser is the granting user as embedded in a grant.
type CosmeticGrantUser struct {
	ID          string  `json:"id"`
	Username    string  `json:"username"`
	DisplayName *string `json:"display_name"`
}

// CosmeticGrant is one grant of a 'granted' server item to the caller.
// GrantedBy is null once the granting account is gone.
type CosmeticGrant struct {
	ItemID    string             `json:"item_id"`
	ServerID  string             `json:"server_id"`
	GrantedBy *CosmeticGrantUser `json:"granted_by"`
	Reason    string             `json:"reason"`
	GrantedAt string             `json:"granted_at"` // RFC3339 UTC
}

// MyEquipped is the caller's raw (unresolved) slots per scope.
type MyEquipped struct {
	Global  CosmeticSlots            `json:"global"`
	Servers map[string]CosmeticSlots `json:"servers"`
}

// MyCosmetics is GET /api/users/me/cosmetics (and the PUT .../equipped
// response).
type MyCosmetics struct {
	Items          []CosmeticItem  `json:"items"`
	Grants         []CosmeticGrant `json:"grants"`
	Equipped       MyEquipped      `json:"equipped"`
	PlainServerIDs []string        `json:"plain_server_ids"`
}

// EquipRequest is PUT /api/users/me/cosmetics/equipped. Scope is "global"
// or a server id. Slots maps 1-5 slot types to an item id, or to null to
// clear the slot; a type left out is unchanged.
type EquipRequest struct {
	Scope string             `json:"scope"`
	Slots map[string]*string `json:"slots"`
}

// Validate checks the request's shape: a well-formed scope, 1-5 known slot
// keys and well-formed item ids. Every failure is ErrCosmeticSlotsInvalid.
func (r *EquipRequest) Validate() error {
	if r.Scope != CosmeticScopeGlobal && !cosmeticIDPattern.MatchString(r.Scope) {
		return ErrCosmeticSlotsInvalid
	}
	if len(r.Slots) == 0 || len(r.Slots) > len(CosmeticTypes) {
		return ErrCosmeticSlotsInvalid
	}
	for key, id := range r.Slots {
		if !IsCosmeticType(key) {
			return ErrCosmeticSlotsInvalid
		}
		if id != nil && !cosmeticIDPattern.MatchString(*id) {
			return ErrCosmeticSlotsInvalid
		}
	}
	return nil
}

// SetPlainServerRequest is PUT /api/users/me/cosmetics/plain-servers/{serverId}.
type SetPlainServerRequest struct {
	Plain *bool `json:"plain"`
}

// CosmeticsLookupResponse is GET /api/users/cosmetics?ids= (global slots
// only, users without any slot left out).
type CosmeticsLookupResponse struct {
	Users map[string]CosmeticSlots `json:"users"`
}

// ServerCosmeticsResponse is GET /api/servers/{serverId}/cosmetics: the
// resolved slots of every member with at least one.
type ServerCosmeticsResponse struct {
	ServerID string                   `json:"server_id"`
	Users    map[string]CosmeticSlots `json:"users"`
}

// CosmeticsUpdateEvent is the WS user_cosmetics_update payload. ServerID nil
// means the global slots (sent to the user only); otherwise Slots are the
// user's resolved slots inside that server (Plain: the user looks plain
// there, Slots is then empty).
type CosmeticsUpdateEvent struct {
	UserID   string        `json:"user_id"`
	ServerID *string       `json:"server_id"`
	Slots    CosmeticSlots `json:"slots"`
	Plain    bool          `json:"plain"`
}

// IsCosmeticType reports whether t is one of the five slot types.
func IsCosmeticType(t string) bool {
	for _, x := range CosmeticTypes {
		if x == t {
			return true
		}
	}
	return false
}

// ValidCosmeticID reports whether id is a well-formed scope / item / user id.
func ValidCosmeticID(id string) bool {
	return cosmeticIDPattern.MatchString(id)
}

// --- Asset schemas (canonical field order = struct order) ---

type cosmeticFrameAsset struct {
	V     int    `json:"v"`
	Frame string `json:"frame"`
}

type cosmeticRasterFrameAsset struct {
	V           int    `json:"v"`
	URL         string `json:"url"`
	AnimatedURL string `json:"animated_url,omitempty"`
}

type cosmeticNameplateAsset struct {
	V       int      `json:"v"`
	Stops   []string `json:"stops"`
	Angle   int      `json:"angle"`
	Pattern string   `json:"pattern"`
}

type cosmeticNameStyleAsset struct {
	V     int      `json:"v"`
	Font  string   `json:"font"`
	Stops []string `json:"stops"`
	Angle int      `json:"angle"`
}

type cosmeticProfileThemeAsset struct {
	V        int       `json:"v"`
	Accent   string    `json:"accent"`
	Gradient [2]string `json:"gradient"`
	Angle    int       `json:"angle"`
}

type cosmeticProfileEffectAsset struct {
	V      int    `json:"v"`
	Effect string `json:"effect"`
	Color  string `json:"color"`
}

// ValidateCosmeticAsset strictly parses a client-renderable asset document
// for (type, format) and returns its canonical re-serialization: one JSON
// object of at most 512 bytes, exactly the schema's keys (case-sensitive,
// no unknown or missing ones), v == 1, integers only for v and angle
// (0-359), hex colors #rrggbb lower-cased, enum values from the fixed
// lists, and for a name style the contrast rule (NameStyleReadable).
// Raster frames are rejected here: their asset is server-built only
// (BuildRasterFrameAsset). Every failure is ErrCosmeticAssetInvalid.
func ValidateCosmeticAsset(cosmeticType, format string, raw []byte) ([]byte, error) {
	out, err := validateCosmeticAsset(cosmeticType, format, raw)
	if err != nil {
		// The decoder's own text is never surfaced (CWE-209).
		return nil, ErrCosmeticAssetInvalid
	}
	return out, nil
}

// ValidateStoredCosmeticAsset is ValidateCosmeticAsset plus the server-
// built raster frame shape - used to re-check an equip-time snapshot before
// it is served.
func ValidateStoredCosmeticAsset(cosmeticType, format string, raw []byte) ([]byte, error) {
	if format != CosmeticFormatRaster {
		return ValidateCosmeticAsset(cosmeticType, format, raw)
	}
	if cosmeticType != CosmeticTypeAvatarFrame {
		return nil, ErrCosmeticAssetInvalid
	}
	fields, err := decodeCosmeticObject(raw, []string{"v", "url"}, []string{"animated_url"})
	if err != nil {
		return nil, ErrCosmeticAssetInvalid
	}
	var url, animated string
	if decodeCosmeticVersion(fields["v"]) != nil || decodeCosmeticString(fields["url"], &url) != nil {
		return nil, ErrCosmeticAssetInvalid
	}
	if a, ok := fields["animated_url"]; ok {
		if decodeCosmeticString(a, &animated) != nil || animated == "" {
			return nil, ErrCosmeticAssetInvalid
		}
	}
	return BuildRasterFrameAsset(url, animated)
}

// BuildRasterFrameAsset returns the canonical asset of a server-made raster
// frame: {"v":1,"url":U} plus "animated_url":A when animatedURL is set. Both
// URLs must match the exact generated shapes.
func BuildRasterFrameAsset(url, animatedURL string) ([]byte, error) {
	if !CosmeticRasterURLPattern.MatchString(url) {
		return nil, ErrCosmeticAssetInvalid
	}
	if animatedURL != "" && !CosmeticRasterAnimatedURLPattern.MatchString(animatedURL) {
		return nil, ErrCosmeticAssetInvalid
	}
	out, err := json.Marshal(cosmeticRasterFrameAsset{V: 1, URL: url, AnimatedURL: animatedURL})
	if err != nil {
		return nil, ErrCosmeticAssetInvalid
	}
	return out, nil
}

func validateCosmeticAsset(cosmeticType, format string, raw []byte) ([]byte, error) {
	switch {
	case cosmeticType == CosmeticTypeAvatarFrame && format == CosmeticFormatSVG:
		fields, err := decodeCosmeticObject(raw, []string{"v", "frame"}, nil)
		if err != nil {
			return nil, err
		}
		a := cosmeticFrameAsset{V: 1}
		if err := decodeCosmeticVersion(fields["v"]); err != nil {
			return nil, err
		}
		if err := decodeCosmeticEnum(fields["frame"], cosmeticFrameKeys, &a.Frame); err != nil {
			return nil, err
		}
		return json.Marshal(a)

	case cosmeticType == CosmeticTypeNameplate && format == CosmeticFormatCSS:
		fields, err := decodeCosmeticObject(raw, []string{"v", "stops", "angle", "pattern"}, nil)
		if err != nil {
			return nil, err
		}
		a := cosmeticNameplateAsset{V: 1}
		if err := decodeCosmeticVersion(fields["v"]); err != nil {
			return nil, err
		}
		if a.Stops, err = decodeCosmeticStops(fields["stops"], 2, 3); err != nil {
			return nil, err
		}
		if a.Angle, err = decodeCosmeticAngle(fields["angle"]); err != nil {
			return nil, err
		}
		if err := decodeCosmeticEnum(fields["pattern"], cosmeticNameplatePatterns, &a.Pattern); err != nil {
			return nil, err
		}
		return json.Marshal(a)

	case cosmeticType == CosmeticTypeNameStyle && format == CosmeticFormatCSS:
		fields, err := decodeCosmeticObject(raw, []string{"v", "font", "stops", "angle"}, nil)
		if err != nil {
			return nil, err
		}
		a := cosmeticNameStyleAsset{V: 1}
		if err := decodeCosmeticVersion(fields["v"]); err != nil {
			return nil, err
		}
		if err := decodeCosmeticEnum(fields["font"], cosmeticNameFonts, &a.Font); err != nil {
			return nil, err
		}
		if a.Stops, err = decodeCosmeticStops(fields["stops"], 1, 2); err != nil {
			return nil, err
		}
		if a.Angle, err = decodeCosmeticAngle(fields["angle"]); err != nil {
			return nil, err
		}
		if !NameStyleReadable(a.Stops) {
			return nil, errCosmeticAssetShape
		}
		return json.Marshal(a)

	case cosmeticType == CosmeticTypeProfileTheme && format == CosmeticFormatCSS:
		fields, err := decodeCosmeticObject(raw, []string{"v", "accent", "gradient", "angle"}, nil)
		if err != nil {
			return nil, err
		}
		a := cosmeticProfileThemeAsset{V: 1}
		if err := decodeCosmeticVersion(fields["v"]); err != nil {
			return nil, err
		}
		if a.Accent, err = decodeCosmeticHex(fields["accent"]); err != nil {
			return nil, err
		}
		stops, err := decodeCosmeticStops(fields["gradient"], 2, 2)
		if err != nil {
			return nil, err
		}
		a.Gradient = [2]string{stops[0], stops[1]}
		if a.Angle, err = decodeCosmeticAngle(fields["angle"]); err != nil {
			return nil, err
		}
		return json.Marshal(a)

	case cosmeticType == CosmeticTypeProfileEffect && format == CosmeticFormatCSS:
		fields, err := decodeCosmeticObject(raw, []string{"v", "effect", "color"}, nil)
		if err != nil {
			return nil, err
		}
		a := cosmeticProfileEffectAsset{V: 1}
		if err := decodeCosmeticVersion(fields["v"]); err != nil {
			return nil, err
		}
		if err := decodeCosmeticEnum(fields["effect"], cosmeticEffects, &a.Effect); err != nil {
			return nil, err
		}
		if a.Color, err = decodeCosmeticHex(fields["color"]); err != nil {
			return nil, err
		}
		return json.Marshal(a)
	}
	return nil, errCosmeticAssetShape
}

// decodeCosmeticObject reads raw as exactly one JSON object whose key set
// is every required key plus any of the optional ones - compared
// case-sensitively here, because encoding/json's struct matching is
// case-insensitive and would accept {"V":1} where the TS parser does not.
func decodeCosmeticObject(raw []byte, required, optional []string) (map[string]json.RawMessage, error) {
	if len(raw) == 0 || len(raw) > CosmeticAssetMaxBytes {
		return nil, errCosmeticAssetShape
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	var fields map[string]json.RawMessage
	if err := dec.Decode(&fields); err != nil {
		return nil, err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, errCosmeticAssetShape
	}
	// JSON null decodes into a nil map.
	if fields == nil {
		return nil, errCosmeticAssetShape
	}
	allowed := make(map[string]bool, len(required)+len(optional))
	for _, k := range required {
		if _, ok := fields[k]; !ok {
			return nil, errCosmeticAssetShape
		}
		allowed[k] = true
	}
	for _, k := range optional {
		allowed[k] = true
	}
	for k := range fields {
		if !allowed[k] {
			return nil, errCosmeticAssetShape
		}
	}
	return fields, nil
}

// decodeCosmeticVersion requires the JSON integer 1 (1.0, "1" and null
// are rejected: decoding a non-integer literal into int fails).
func decodeCosmeticVersion(raw json.RawMessage) error {
	var v *int
	if err := json.Unmarshal(raw, &v); err != nil {
		return err
	}
	if v == nil || *v != 1 {
		return errCosmeticAssetShape
	}
	return nil
}

func decodeCosmeticAngle(raw json.RawMessage) (int, error) {
	var v *int
	if err := json.Unmarshal(raw, &v); err != nil {
		return 0, err
	}
	if v == nil || *v < 0 || *v > 359 {
		return 0, errCosmeticAssetShape
	}
	return *v, nil
}

func decodeCosmeticString(raw json.RawMessage, dst *string) error {
	var v *string
	if err := json.Unmarshal(raw, &v); err != nil {
		return err
	}
	if v == nil {
		return errCosmeticAssetShape
	}
	*dst = *v
	return nil
}

func decodeCosmeticEnum(raw json.RawMessage, allowed map[string]bool, dst *string) error {
	if err := decodeCosmeticString(raw, dst); err != nil {
		return err
	}
	if !allowed[*dst] {
		return errCosmeticAssetShape
	}
	return nil
}

func decodeCosmeticHex(raw json.RawMessage) (string, error) {
	var s string
	if err := decodeCosmeticString(raw, &s); err != nil {
		return "", err
	}
	return canonicalCosmeticHex(s)
}

func canonicalCosmeticHex(s string) (string, error) {
	if !cosmeticHexPattern.MatchString(s) {
		return "", errCosmeticAssetShape
	}
	return string(bytes.ToLower([]byte(s))), nil
}

func decodeCosmeticStops(raw json.RawMessage, minStops, maxStops int) ([]string, error) {
	var stops []*string
	if err := json.Unmarshal(raw, &stops); err != nil {
		return nil, err
	}
	if len(stops) < minStops || len(stops) > maxStops {
		return nil, errCosmeticAssetShape
	}
	out := make([]string, 0, len(stops))
	for _, s := range stops {
		if s == nil {
			return nil, errCosmeticAssetShape
		}
		hex, err := canonicalCosmeticHex(*s)
		if err != nil {
			return nil, err
		}
		out = append(out, hex)
	}
	return out, nil
}

// --- Slot resolution ---

// CosmeticScopeSlots returns the slots of the rows stored in exactly
// scopeServerID (empty = global), each snapshot re-validated. A global row
// pointing at a server item, or a server row pointing at another server's
// item, is skipped (defensive - Equip never writes either).
func CosmeticScopeSlots(rows []CosmeticEquippedRow, scopeServerID string) CosmeticSlots {
	out := CosmeticSlots{}
	for _, r := range rows {
		if r.ScopeServerID != scopeServerID {
			continue
		}
		if r.ItemServerID != nil && (scopeServerID == "" || *r.ItemServerID != scopeServerID) {
			continue
		}
		asset, err := ValidateStoredCosmeticAsset(r.Type, r.Format, []byte(r.AssetSnapshot))
		if err != nil {
			continue
		}
		out[r.Type] = EquippedCosmetic{ItemID: r.ItemID, Format: r.Format, Animated: r.Animated, Asset: asset}
	}
	return out
}

// ResolveCosmeticSlots is the resolution rule (TS resolveSlots): in a
// server context each type takes the server row over the global one; in
// the global context (empty serverID) only global rows apply. The "plain in
// this server" switch is applied by the caller.
func ResolveCosmeticSlots(rows []CosmeticEquippedRow, serverID string) CosmeticSlots {
	out := CosmeticScopeSlots(rows, "")
	if serverID == "" {
		return out
	}
	for t, s := range CosmeticScopeSlots(rows, serverID) {
		out[t] = s
	}
	return out
}
