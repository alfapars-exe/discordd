// backfill-music-privacy reviews one bounded historical privacy batch. It
// never migrates schema or runs automatically. Stop application writes and
// take a protected backup before explicit apply; never put DSNs on argv.
package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/repository"
	_ "modernc.org/sqlite"
)

type maintenancePlan struct {
	*repository.MusicPrivacyBackfillReport
	TargetHash string `json:"target_hash"`
}

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func readPlan(path string) (*maintenancePlan, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, errors.New("cannot open maintenance plan")
	}
	defer file.Close()
	var plan maintenancePlan
	decoder := json.NewDecoder(io.LimitReader(file, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&plan); err != nil {
		return nil, errors.New("invalid maintenance plan")
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		return nil, errors.New("unexpected trailing maintenance plan content")
	}
	if plan.MusicPrivacyBackfillReport == nil || plan.Format != "hichat-music-privacy-backfill-v1" || len(plan.SourceHash) != 64 || len(plan.TargetHash) != 64 || plan.Limit < 1 || plan.Limit > 100 {
		return nil, errors.New("invalid maintenance plan contract")
	}
	return &plan, nil
}
func run(args []string, out io.Writer) error {
	flags := flag.NewFlagSet("backfill-music-privacy", flag.ContinueOnError)
	offline := flags.Bool("offline-confirmed", false, "confirm application writes are stopped and a protected backup exists before apply")
	limit := flags.Int("limit", 25, "maximum rows per table, 1-100")
	apply := flags.String("apply-plan", "", "explicitly apply this reviewed dry-run JSON plan")
	cursorPlan := flags.String("cursor-plan", "", "start dry-run at a prior plan's next_cursor")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected arguments")
	}
	if *limit < 1 || *limit > 100 {
		return errors.New("limit must be 1-100")
	}
	if *apply != "" && !*offline {
		return errors.New("apply requires --offline-confirmed after stopping application writes and taking a protected backup")
	}
	if *apply != "" && *cursorPlan != "" {
		return errors.New("apply-plan and cursor-plan are mutually exclusive")
	}
	var expected string
	var cursor repository.MusicPrivacyCursor
	var plan *maintenancePlan
	if *apply != "" || *cursorPlan != "" {
		path := *cursorPlan
		if *apply != "" {
			path = *apply
		}
		var err error
		plan, err = readPlan(path)
		if err != nil {
			return err
		}
		if *apply != "" {
			changedLimit := false
			flags.Visit(func(f *flag.Flag) {
				if f.Name == "limit" {
					changedLimit = true
				}
			})
			if changedLimit {
				return errors.New("apply uses the reviewed plan limit; do not override it")
			}
			if plan.Applied {
				return errors.New("apply requires a dry-run plan, not an applied result")
			}
			cursor, expected, *limit = plan.Cursor, plan.SourceHash, plan.Limit
		} else {
			cursor = plan.NextCursor
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	db, targetHash, err := openMaintenanceDB(ctx, os.Getenv("HICHAT_MUSIC_PRIVACY_DATABASE_URL"))
	if err != nil {
		return err
	}
	defer db.Close()
	if plan != nil && plan.TargetHash != targetHash {
		return errors.New("maintenance plan targets another database")
	}
	report, err := repository.BackfillMusicPrivacyBatch(ctx, db, cursor, *limit, expected)
	if err != nil {
		return fmt.Errorf("music privacy batch failed: %w", err)
	}
	encoder := json.NewEncoder(out)
	encoder.SetIndent("", "  ")
	return encoder.Encode(maintenancePlan{report, targetHash})
}
func openMaintenanceDB(ctx context.Context, source string) (*sql.DB, string, error) {
	if source == "" {
		return nil, "", errors.New("HICHAT_MUSIC_PRIVACY_DATABASE_URL is required through local environment")
	}
	var db *sql.DB
	var identity string
	var err error
	if database.IsPostgresDSN(source) {
		parsed, parseErr := url.Parse(source)
		if parseErr != nil {
			return nil, "", errors.New("invalid database configuration")
		}
		identity = "postgres:" + parsed.Host + parsed.Path + ":" + parsed.Query().Get("search_path")
		db, err = database.OpenPostgres(ctx, source)
	} else {
		if database.IsRemoteDatabase(source) {
			return nil, "", errors.New("this maintenance command supports existing local SQLite files or verified PostgreSQL only")
		}
		absolute, pathErr := filepath.Abs(source)
		if pathErr != nil {
			return nil, "", errors.New("invalid SQLite path")
		}
		info, statErr := os.Lstat(absolute)
		if statErr != nil || !info.Mode().IsRegular() {
			return nil, "", errors.New("SQLite source must be an existing regular file")
		}
		identity = "sqlite:" + filepath.Clean(absolute)
		u := url.URL{Scheme: "file", Opaque: filepath.ToSlash(absolute)}
		q := u.Query()
		q.Set("mode", "rw")
		q.Add("_pragma", "foreign_keys(1)")
		q.Add("_pragma", "busy_timeout(5000)")
		u.RawQuery = q.Encode()
		db, err = sql.Open("sqlite", u.String())
		if err == nil {
			db.SetMaxOpenConns(1)
			err = db.PingContext(ctx)
		}
	}
	if err != nil {
		if db != nil {
			db.Close()
		}
		return nil, "", errors.New("cannot open configured maintenance database")
	}
	sum := sha256.Sum256([]byte(identity))
	return db, hex.EncodeToString(sum[:]), nil
}
