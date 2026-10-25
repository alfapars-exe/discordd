-- SQLite-compatible booleans remain integers in the shared repository layer.
ALTER TABLE servers ADD COLUMN is_community INTEGER NOT NULL DEFAULT 0 CHECK (is_community IN (0, 1));
