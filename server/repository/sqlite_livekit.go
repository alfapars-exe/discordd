package repository

// sqliteLiveKitRepo is the SQLite-backed LiveKitRepository. Its methods are
// split by concern across sibling files: sqlite_livekit_instances.go (CRUD),
// sqlite_livekit_quota.go (usage/quota), sqlite_livekit_migration.go (server
// migration), and sqlite_livekit_scan.go (column list + row scanning).

import "github.com/argeinfina/hichat/database"

type sqliteLiveKitRepo struct {
	db database.TxQuerier
}

func NewSQLiteLiveKitRepo(db database.TxQuerier) LiveKitRepository {
	return &sqliteLiveKitRepo{db: db}
}
