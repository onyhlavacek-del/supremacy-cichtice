// SQLite databáze (vestavěné node:sqlite) — perzistentní stav hry
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'data'), { recursive: true });
export const db = new DatabaseSync(join(ROOT, 'data', 'game.db'));

db.exec(`
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  color TEXT NOT NULL,
  capital_id INTEGER,
  home_id INTEGER,
  education INTEGER DEFAULT 0,
  edu_course_level INTEGER,
  edu_course_until INTEGER,
  max_morale REAL DEFAULT 100,
  team_with INTEGER,             -- hraje v týmu s hráčem (sourozenec, volba (a)) — sdílená říše
  sibling_with INTEGER,          -- rozdělený dům: druhý hráč (volba (b))
  sibling_until INTEGER,         -- do kdy na sebe nesmí útočit
  created INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS province_custom (
  id INTEGER PRIMARY KEY,        -- nové id (base + 100000)
  base_id INTEGER NOT NULL,      -- z jaké provincie vznikla rozdělením
  name TEXT NOT NULL,
  poly TEXT NOT NULL,            -- JSON polygon
  adjacent TEXT NOT NULL         -- JSON [ids]
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  player_id INTEGER NOT NULL,
  created INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS resources (
  player_id INTEGER NOT NULL,
  res TEXT NOT NULL,
  amount REAL DEFAULT 0,
  PRIMARY KEY (player_id, res)
);

CREATE TABLE IF NOT EXISTS province_state (
  id INTEGER PRIMARY KEY,          -- odpovídá provinces.json
  owner_id INTEGER,                -- NULL = neutrální/volná příroda
  morale REAL DEFAULT 60,
  fortress INTEGER DEFAULT 0,
  barracks INTEGER DEFAULT 0,
  recruit_progress REAL DEFAULT 0, -- rozpracovaný pěšák (0..1)
  build_kind TEXT,                 -- probíhající stavba: 'fortress' | 'barracks'
  build_until INTEGER,
  unit_kind TEXT,                  -- probíhající výroba jednotky
  unit_until INTEGER,
  captured_ts INTEGER
);

CREATE TABLE IF NOT EXISTS armies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL,
  province_id INTEGER,             -- kde stojí (NULL = na cestě)
  units TEXT NOT NULL,             -- JSON {infantry: 5, ...}
  morale REAL DEFAULT 100,
  path TEXT,                       -- JSON [provinceId,...] zbývající trasa
  next_arrive INTEGER,             -- ts příchodu do dalšího uzlu trasy
  depart_delay_until INTEGER,      -- příprava vzdáleného rozkazu
  stance TEXT DEFAULT 'move'       -- move | attack
);

CREATE TABLE IF NOT EXISTS battles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  province_id INTEGER NOT NULL,
  next_round INTEGER NOT NULL,
  started INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS presence (
  player_id INTEGER PRIMARY KEY,
  x REAL, y REAL,
  ts INTEGER
);

CREATE TABLE IF NOT EXISTS trips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  kind TEXT NOT NULL,              -- walk | bike
  start_ts INTEGER NOT NULL,
  start_x REAL, start_y REAL,
  status TEXT DEFAULT 'active'     -- active | done | cancelled
);

CREATE TABLE IF NOT EXISTS discovery (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  x REAL NOT NULL, y REAL NOT NULL, r REAL NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_discovery_player ON discovery (player_id);

CREATE TABLE IF NOT EXISTS visits (
  player_id INTEGER NOT NULL,
  poi_key TEXT NOT NULL,           -- 'peak:Hnojnice' | 'town:Vodňany'
  ts INTEGER NOT NULL,
  PRIMARY KEY (player_id, poi_key)
);

CREATE TABLE IF NOT EXISTS shops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  town TEXT NOT NULL,
  res TEXT NOT NULL,
  stock REAL DEFAULT 0,
  earned REAL DEFAULT 0,
  UNIQUE (player_id, town)
);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id INTEGER NOT NULL,
  to_id INTEGER,                   -- NULL = veřejná nabídka
  give TEXT NOT NULL,              -- JSON {res: amount, money: m}
  want TEXT NOT NULL,
  status TEXT DEFAULT 'open',      -- open | accepted | cancelled
  created INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alliances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS alliance_members (
  alliance_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS alliance_invites (
  alliance_id INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  PRIMARY KEY (alliance_id, player_id)
);

CREATE TABLE IF NOT EXISTS war (
  a INTEGER NOT NULL,
  b INTEGER NOT NULL,
  since INTEGER NOT NULL,
  PRIMARY KEY (a, b)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER,               -- NULL = všem
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS badges (
  player_id INTEGER NOT NULL,
  badge TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (player_id, badge)
);

CREATE TABLE IF NOT EXISTS chat (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pacts (
  a INTEGER NOT NULL,              -- kdo nabídl
  b INTEGER NOT NULL,
  status TEXT DEFAULT 'offered',   -- offered | active
  since INTEGER NOT NULL,
  PRIMARY KEY (a, b)
);

CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  kind TEXT NOT NULL,              -- chyba | napad | jine
  text TEXT NOT NULL,
  ts INTEGER NOT NULL,
  sent INTEGER DEFAULT 0           -- doslo na Discord?
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// migrace: soukromé zprávy v chatu
try { db.exec('ALTER TABLE chat ADD COLUMN to_id INTEGER'); } catch { /* sloupec už existuje */ }
// migrace: znak a barva aliance
try { db.exec("ALTER TABLE alliances ADD COLUMN symbol TEXT DEFAULT 'swords'"); } catch { /* už existuje */ }
try { db.exec("ALTER TABLE alliances ADD COLUMN bg TEXT DEFAULT '#1565C0'"); } catch { /* už existuje */ }
// migrace: vylepšení přírodních území
try { db.exec("ALTER TABLE province_state ADD COLUMN upgrades TEXT DEFAULT '{}'"); } catch { /* sloupec už existuje */ }

export const q = {
  get: (sql, ...p) => db.prepare(sql).get(...p),
  all: (sql, ...p) => db.prepare(sql).all(...p),
  run: (sql, ...p) => db.prepare(sql).run(...p),
};

export function metaGet(key, def = null) {
  const r = q.get('SELECT value FROM meta WHERE key = ?', key);
  return r ? r.value : def;
}
export function metaSet(key, value) {
  q.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
}
