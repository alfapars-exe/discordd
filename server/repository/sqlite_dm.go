package repository

import (
	"github.com/argeinfina/hichat/database"
)

type sqliteDMRepo struct {
	db database.TxQuerier
}

func NewSQLiteDMRepo(db database.TxQuerier) DMRequestStore {
	return &sqliteDMRepo{db: db}
}
