package repository

import (
	"github.com/argeinfina/hichat/database"
)

type sqliteDMRepo struct {
	db database.TxQuerier
}

func NewSQLiteDMRepo(db database.TxQuerier) DMRepository {
	return &sqliteDMRepo{db: db}
}
