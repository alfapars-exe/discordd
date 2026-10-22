// Migration 089 (cosmetics) tests. Same shape as migration_088_test.go: the
// file is applied in isolation (FK enforcement is off in newRunnerTestDB, so
// no users/servers fixture is needed), then re-run raw to prove the IF NOT
// EXISTS guards and INSERT OR IGNORE seed make it idempotent. Every seeded
// asset must pass models.ValidateCosmeticAsset and already be canonical.
package database

import (
	"testing"

	"github.com/argeinfina/hichat/models"
)

const migration089 = "089_cosmetics.sql"

const migration089SeedCount = 30

var migration089Tables = []string{
	"cosmetic_items",
	"user_cosmetics",
	"user_equipped",
	"user_cosmetic_plain_servers",
}

var migration089Indexes = []string{
	"idx_cosmetic_items_server",
	"idx_cosmetic_items_file_url",
	"idx_cosmetic_items_animated_url",
	"idx_user_cosmetics_item",
	"idx_user_cosmetics_server",
	"idx_user_equipped_item",
	"idx_user_equipped_scope",
	"idx_user_cosmetic_plain_servers_server",
}

func applyMigration089(t *testing.T) *DB {
	t.Helper()
	db := newRunnerTestDB(t)
	mustCreateSchemaMigrations(t, db)
	content := readEmbeddedMigration(t, migration089)
	if err := db.applyMigrationFile(migration089, content); err != nil {
		t.Fatalf("apply migration 089: %v", err)
	}
	return db
}

func TestMigration089_CreatesTablesIndexesAndSeed(t *testing.T) {
	db := applyMigration089(t)

	for _, tbl := range migration089Tables {
		if n := count(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?`, tbl); n != 1 {
			t.Errorf("%s table not found after migration 089", tbl)
		}
	}
	for _, idx := range migration089Indexes {
		if n := count(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?`, idx); n != 1 {
			t.Errorf("%s index not found after migration 089", idx)
		}
	}
	if n := count(t, db, `SELECT COUNT(*) FROM cosmetic_items`); n != migration089SeedCount {
		t.Errorf("seeded items = %d, want %d", n, migration089SeedCount)
	}
	if n := count(t, db, `SELECT COUNT(*) FROM cosmetic_items WHERE server_id IS NULL AND availability = 'free'
		AND id LIKE 'b\_%' ESCAPE '\' AND created_at LIKE '____-__-__ __:__:__'`); n != migration089SeedCount {
		t.Errorf("built-in free b_ items with text timestamps = %d, want %d", n, migration089SeedCount)
	}
	for typ, want := range map[string]int{
		models.CosmeticTypeAvatarFrame: 6, models.CosmeticTypeNameplate: 6, models.CosmeticTypeNameStyle: 6,
		models.CosmeticTypeProfileTheme: 6, models.CosmeticTypeProfileEffect: 6,
	} {
		if n := count(t, db, `SELECT COUNT(*) FROM cosmetic_items WHERE type = ?`, typ); n != want {
			t.Errorf("%s seeds = %d, want %d", typ, n, want)
		}
	}
}

// TestMigration089_SeedAssetsAreValidAndCanonical runs every seed through
// the strict validator: it must pass, and its canonical form must equal the
// stored text byte for byte. Name styles must also be readable.
func TestMigration089_SeedAssetsAreValidAndCanonical(t *testing.T) {
	db := applyMigration089(t)

	rows, err := db.Conn.Query(`SELECT id, type, format, asset_json FROM cosmetic_items ORDER BY id`)
	if err != nil {
		t.Fatalf("query seeds: %v", err)
	}
	defer rows.Close()
	seen := 0
	for rows.Next() {
		var id, typ, format, asset string
		if err := rows.Scan(&id, &typ, &format, &asset); err != nil {
			t.Fatalf("scan seed: %v", err)
		}
		seen++
		canonical, err := models.ValidateCosmeticAsset(typ, format, []byte(asset))
		if err != nil {
			t.Errorf("%s: seed asset %s rejected: %v", id, asset, err)
			continue
		}
		if string(canonical) != asset {
			t.Errorf("%s: seed asset not canonical:\n got %s\nwant %s", id, asset, canonical)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate seeds: %v", err)
	}
	if seen != migration089SeedCount {
		t.Errorf("validated %d seeds, want %d", seen, migration089SeedCount)
	}
}

func TestMigration089_CheckConstraints(t *testing.T) {
	db := applyMigration089(t)

	reject := map[string]string{
		"raster with asset_json": `INSERT INTO cosmetic_items (id, server_id, type, format, name, asset_json, file_url)
			VALUES ('r1', 'srv', 'avatar_frame', 'raster', 'x', '{"v":1}', '/api/uploads/cosmetics/0123456789abcdef.png')`,
		"built-in raster": `INSERT INTO cosmetic_items (id, server_id, type, format, name, file_url)
			VALUES ('r2', NULL, 'avatar_frame', 'raster', 'x', '/api/uploads/cosmetics/0123456789abcdef.png')`,
		"raster nameplate": `INSERT INTO cosmetic_items (id, server_id, type, format, name, file_url)
			VALUES ('r3', 'srv', 'nameplate', 'raster', 'x', '/api/uploads/cosmetics/0123456789abcdef.png')`,
		"svg with server_id": `INSERT INTO cosmetic_items (id, server_id, type, format, name, asset_json)
			VALUES ('s1', 'srv', 'avatar_frame', 'svg', 'x', '{"v":1,"frame":"aurora"}')`,
		"svg nameplate": `INSERT INTO cosmetic_items (id, server_id, type, format, name, asset_json)
			VALUES ('s2', NULL, 'nameplate', 'svg', 'x', '{}')`,
		"css frame": `INSERT INTO cosmetic_items (id, server_id, type, format, name, asset_json)
			VALUES ('c1', 'srv', 'avatar_frame', 'css', 'x', '{"v":1,"frame":"aurora"}')`,
		"css with file_url": `INSERT INTO cosmetic_items (id, server_id, type, format, name, asset_json, file_url)
			VALUES ('c2', 'srv', 'nameplate', 'css', 'x', '{}', '/api/uploads/cosmetics/0123456789abcdef.png')`,
		"built-in granted": `INSERT INTO cosmetic_items (id, server_id, type, format, name, asset_json, availability)
			VALUES ('g1', NULL, 'nameplate', 'css', 'x', '{}', 'granted')`,
		"unknown type": `INSERT INTO cosmetic_items (id, server_id, type, format, name, asset_json)
			VALUES ('t1', 'srv', 'badge', 'css', 'x', '{}')`,
		"equipped unknown type": `INSERT INTO user_equipped (user_id, scope_server_id, type, item_id, format, asset_snapshot)
			VALUES ('u1', '', 'badge', 'b_frame_aurora', 'svg', '{}')`,
	}
	for name, stmt := range reject {
		if _, err := db.Conn.Exec(stmt); err == nil {
			t.Errorf("%s accepted, want CHECK failure", name)
		}
	}

	// Valid server-made rows: a css nameplate (granted) and a raster frame.
	mustExec(t, db, `INSERT INTO cosmetic_items (id, server_id, type, format, name, asset_json, availability)
		VALUES ('0123456789abcdef', 'srv', 'nameplate', 'css', 'x', '{}', 'granted')`)
	mustExec(t, db, `INSERT INTO cosmetic_items (id, server_id, type, format, name, file_url, animated_url, animated)
		VALUES ('fedcba9876543210', 'srv', 'avatar_frame', 'raster', 'x',
			'/api/uploads/cosmetics/fedcba9876543210.png', '/api/uploads/cosmetics/fedcba9876543210.gif', 1)`)
	// UNIQUE file_url.
	if _, err := db.Conn.Exec(`INSERT INTO cosmetic_items (id, server_id, type, format, name, file_url)
		VALUES ('aaaaaaaaaaaaaaaa', 'srv', 'avatar_frame', 'raster', 'y', '/api/uploads/cosmetics/fedcba9876543210.png')`); err == nil {
		t.Error("duplicate file_url accepted, want UNIQUE failure")
	}

	// user_equipped: one row per (user, scope, type), scope defaults to ''.
	mustExec(t, db, `INSERT INTO user_equipped (user_id, type, item_id, format, asset_snapshot)
		VALUES ('u1', 'avatar_frame', 'b_frame_aurora', 'svg', '{"v":1,"frame":"aurora"}')`)
	if _, err := db.Conn.Exec(`INSERT INTO user_equipped (user_id, scope_server_id, type, item_id, format, asset_snapshot)
		VALUES ('u1', '', 'avatar_frame', 'b_frame_ember', 'svg', '{"v":1,"frame":"ember"}')`); err == nil {
		t.Error("second global avatar_frame row accepted, want PK failure")
	}
	if n := count(t, db, `SELECT COUNT(*) FROM user_equipped WHERE scope_server_id = '' AND equipped_at LIKE '____-__-__ __:__:__'`); n != 1 {
		t.Error("user_equipped defaults (scope '', text timestamp) not applied")
	}
}

func TestMigration089_SecondRunIsIdempotent(t *testing.T) {
	db := applyMigration089(t)
	content := readEmbeddedMigration(t, migration089)
	if err := execRawStatements(t, db, migration089, content); err != nil {
		t.Fatalf("re-apply migration 089 statements (second run): %v", err)
	}
	if n := count(t, db, `SELECT COUNT(*) FROM cosmetic_items`); n != migration089SeedCount {
		t.Errorf("items after two runs = %d, want %d", n, migration089SeedCount)
	}
	for _, tbl := range migration089Tables {
		if n := count(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?`, tbl); n != 1 {
			t.Errorf("%s table count after two runs = %d, want 1", tbl, n)
		}
	}
	for _, idx := range migration089Indexes {
		if n := count(t, db, `SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?`, idx); n != 1 {
			t.Errorf("%s count after two runs = %d, want 1", idx, n)
		}
	}
}
