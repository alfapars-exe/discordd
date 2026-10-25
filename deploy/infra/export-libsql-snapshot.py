import base64
import json
import os
import sqlite3
import sys
import urllib.parse
import urllib.request

os.umask(0o077)
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/hichat-source-snapshot.db"
dsn = os.environ.get("DATABASE_URL", "")
u = urllib.parse.urlparse(dsn)
if u.scheme not in ("libsql", "https", "http") or not u.netloc:
    raise SystemExit("DATABASE_URL is not a supported remote libSQL URL")
q = urllib.parse.parse_qs(u.query)
token = (q.get("authToken") or q.get("auth_token") or [""])[0]
if not token:
    raise SystemExit("DATABASE_URL has no auth token")
endpoint = ("https" if u.scheme == "libsql" else u.scheme) + "://" + u.netloc + "/v2/pipeline"
baton = None

def value(v):
    if v is None or v.get("type") == "null": return None
    if v.get("type") == "blob": return base64.b64decode(v.get("base64", ""))
    if v.get("type") == "integer": return int(v.get("value", "0"))
    if v.get("type") == "float": return float(v.get("value", "0"))
    return v.get("value", "")

def query(sql, args=()):
    global baton, endpoint
    req = {"baton": baton, "requests": [{"type": "execute", "stmt": {"sql": sql, "args": [{"type": "text", "value": str(a)} if a is not None else {"type": "null"} for a in args]}}]}
    data = json.dumps(req).encode()
    request = urllib.request.Request(endpoint, data=data, headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=120) as response: payload = json.load(response)
    baton = payload.get("baton")
    if payload.get("base_url"):
        base = urllib.parse.urlparse(payload["base_url"])
        if base.scheme != "https" or not base.hostname or not (base.hostname.endswith(".turso.io") or base.hostname == u.hostname):
            raise RuntimeError("unexpected libSQL stream base URL")
        endpoint = payload["base_url"].rstrip("/") + "/v2/pipeline"
    item = payload["results"][0]
    if item.get("type") == "error": raise RuntimeError(item.get("error", {}).get("message", "libSQL query failed"))
    result = item["response"]["result"]
    cols = [c["name"] for c in result.get("cols", [])]
    return cols, [[value(v) for v in row] for row in result.get("rows", [])]

def ident(s): return '"' + s.replace('"', '""') + '"'

query("BEGIN DEFERRED TRANSACTION")
if not baton:
    raise RuntimeError("server did not retain snapshot transaction")
cols, rows = query("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'trigger' THEN 2 WHEN 'view' THEN 3 ELSE 4 END, name")
os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
try: os.remove(OUT)
except FileNotFoundError: pass
db = sqlite3.connect(OUT)
db.execute("PRAGMA journal_mode=DELETE")
db.execute("PRAGMA foreign_keys=OFF")
tables = []
without_rowid = set()
for typ, name, sql in rows:
    if typ != "table" or not sql or name.endswith("_fts") or "_fts_" in name or "VIRTUAL TABLE" in sql.upper(): continue
    db.execute(sql)
    tables.append(name)
    if "WITHOUT ROWID" in sql.upper(): without_rowid.add(name)
for name in tables:
    print("exporting", name, file=sys.stderr, flush=True)
    offset = 0
    cursor = None
    while True:
        # Keep each response and the subsequent SQLite insert bounded so a
        # small VM cannot expire the retained HTTP transaction while decoding
        # an entire telemetry table. Preserve SQLite rowids as well as IDs.
        if name in without_rowid:
            c, data = query("SELECT * FROM " + ident(name) + " LIMIT 1000 OFFSET " + str(offset))
        elif cursor is None:
            c, data = query("SELECT rowid AS __snapshot_rowid__, * FROM " + ident(name) + " ORDER BY rowid LIMIT 1000")
        else:
            c, data = query("SELECT rowid AS __snapshot_rowid__, * FROM " + ident(name) + " WHERE rowid>CAST(? AS INTEGER) ORDER BY rowid LIMIT 1000", (cursor,))
        if not data: break
        if name not in without_rowid:
            cursor = data[-1][0]
            c[0] = "rowid"
        placeholders = ",".join("?" for _ in c)
        db.executemany("INSERT INTO " + ident(name) + " (" + ",".join(ident(x) for x in c) + ") VALUES (" + placeholders + ")", data)
        offset += len(data)
_, sequence_exists = query("SELECT name FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'")
if sequence_exists:
    _, sequences = query("SELECT name,seq FROM sqlite_sequence")
    for name, seq in sequences:
        if name in tables:
            db.execute("DELETE FROM sqlite_sequence WHERE name=?", (name,))
            db.execute("INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)", (name,seq))
query("COMMIT")
db.commit()
# Indexes/triggers are deliberately omitted. The migration rehearsal applies
# the current schema and rebuilds them after copying table data.
db.commit()
db.close()
check = sqlite3.connect(OUT)
print(json.dumps({"path": OUT, "tables": len(tables), "bytes": os.path.getsize(OUT), "integrity": check.execute("PRAGMA integrity_check").fetchone()[0]}))
check.close()
