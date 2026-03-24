import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
const DB_PATH = process.env.VAULT_DB_PATH ??
    path.resolve(process.cwd(), "data", "vaultapi.sqlite");
// Ensure parent dir exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
export const db = new Database(DB_PATH);
// basic pragmas
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
function ensureColumn(table, column, ddl) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    const has = cols.some((c) => c.name === column);
    if (!has)
        db.exec(ddl);
}
function nowIso() {
    return new Date().toISOString();
}
export function getFoundryCursor(worldId, day, hour) {
    const row = db.prepare(`
    SELECT after_ts AS afterTs
    FROM foundry_chat_cursors
    WHERE world_id = ? AND day = ? AND hour = ?
  `).get(String(worldId), String(day), String(hour));
    return row ? { afterTs: Number(row.afterTs ?? 0) } : null;
}
export function upsertFoundryCursor(worldId, day, hour, afterTs) {
    const ts = Math.max(0, Math.trunc(Number(afterTs ?? 0)));
    db.prepare(`
    INSERT INTO foundry_chat_cursors (world_id, day, hour, after_ts, updated_at)
    VALUES (@worldId, @day, @hour, @afterTs, @now)
    ON CONFLICT(world_id, day, hour)
    DO UPDATE SET after_ts = excluded.after_ts, updated_at = excluded.updated_at
  `).run({
        worldId: String(worldId),
        day: String(day),
        hour: String(hour),
        afterTs: ts,
        now: nowIso(),
    });
    return { ok: true };
}
export function migrate() {
    db.exec(`
CREATE TABLE IF NOT EXISTS vault_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  display_name TEXT,
  password_hash TEXT,
  must_reset_password INTEGER NOT NULL DEFAULT 0,
  is_superadmin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS world_user_links (
  vault_user_id TEXT NOT NULL,
  world_id TEXT NOT NULL,
  foundry_user_id TEXT,                 -- optional
  role TEXT NOT NULL DEFAULT 'player',  -- 'dm' | 'player' | 'observer'
  linked_at TEXT NOT NULL,

  PRIMARY KEY (vault_user_id, world_id),
  UNIQUE (world_id, foundry_user_id),

  FOREIGN KEY (vault_user_id) REFERENCES vault_users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_world_user_links_world ON world_user_links(world_id);
CREATE INDEX IF NOT EXISTS idx_world_user_links_user ON world_user_links(vault_user_id);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL,
  foundry_user_id TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'player',  -- invite grants this role
  code_hash TEXT NOT NULL UNIQUE,
  created_by_vault_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  max_uses INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (created_by_vault_user_id) REFERENCES vault_users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_invites_world ON invites(world_id);

CREATE TABLE IF NOT EXISTS world_actor_links (
  world_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  vault_user_id TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'owner',  -- 'owner' | 'editor' | 'viewer'
  linked_at TEXT NOT NULL,

  PRIMARY KEY (world_id, actor_id, vault_user_id),
  FOREIGN KEY (vault_user_id) REFERENCES vault_users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_world_actor_links_world ON world_actor_links(world_id);
CREATE INDEX IF NOT EXISTS idx_world_actor_links_user ON world_actor_links(vault_user_id);
CREATE INDEX IF NOT EXISTS idx_world_actor_links_actor ON world_actor_links(actor_id);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id TEXT PRIMARY KEY,
  vault_user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_by_vault_user_id TEXT,
  FOREIGN KEY (vault_user_id) REFERENCES vault_users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pwreset_user ON password_reset_tokens(vault_user_id);

/* =========================================================
 *  Unified event log (Foundry + Vaulthero)
 * ========================================================= */
CREATE TABLE IF NOT EXISTS log_events (
  id TEXT PRIMARY KEY,                  -- stable id (e.g. foundry:day:hour:file or vh:uuid)
  world_id TEXT NOT NULL,
  ts INTEGER NOT NULL,                  -- epoch ms
  source TEXT NOT NULL,                 -- foundry | vaulthero | ...
  kind TEXT NOT NULL,                   -- chat | roll | attack | ...

  actor_id TEXT,                        -- optional
  actor_name TEXT,                      -- optional

  title TEXT,                           -- optional
  summary TEXT,                         -- optional (plain-ish)
  html TEXT,                            -- optional (rendered message)

  group_id TEXT,                        -- optional (e.g. foundry message id for grouping)
  data_json TEXT                        -- optional (raw payload or extra data)
);

CREATE INDEX IF NOT EXISTS idx_log_events_world_ts
  ON log_events(world_id, ts);

CREATE INDEX IF NOT EXISTS idx_log_events_world_kind_ts
  ON log_events(world_id, kind, ts);

CREATE INDEX IF NOT EXISTS idx_log_events_world_source_ts
  ON log_events(world_id, source, ts);

CREATE INDEX IF NOT EXISTS idx_log_events_world_actor_ts
  ON log_events(world_id, actor_id, ts);

CREATE INDEX IF NOT EXISTS idx_log_events_world_group_ts
  ON log_events(world_id, group_id, ts);

/* =========================================================
 *  MEDIA
 * ========================================================= */
CREATE TABLE IF NOT EXISTS media_objects (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT,
  byte_size INTEGER,
  sha256 TEXT,
  storage TEXT NOT NULL DEFAULT 'vault',
  path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by_vault_user_id TEXT,
  deleted_at TEXT,
  FOREIGN KEY (created_by_vault_user_id) REFERENCES vault_users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_media_world ON media_objects(world_id);

/* =========================================================
 *  QUEST TEMPLATES
 * ========================================================= */
CREATE TABLE IF NOT EXISTS quest_templates (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  body TEXT,
  category TEXT,      
  tags_json TEXT,
  reward_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_vault_user_id TEXT,
  updated_by_vault_user_id TEXT,
  deleted_at TEXT,
  FOREIGN KEY (created_by_vault_user_id) REFERENCES vault_users(id) ON DELETE SET NULL,
  FOREIGN KEY (updated_by_vault_user_id) REFERENCES vault_users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_qtmpl_world ON quest_templates(world_id);

/* =========================================================
 *  QUESTS (includes timers / availability)
 * ========================================================= */
CREATE TABLE IF NOT EXISTS quests (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL,
  template_id TEXT,

  category TEXT,                 -- <-- ADD THIS
  title TEXT NOT NULL,
  summary TEXT,
  body TEXT,

  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('draft','active','completed','failed','archived')),

  priority INTEGER NOT NULL DEFAULT 0,
  tags_json TEXT,

  reward_json TEXT,
  visibility TEXT NOT NULL DEFAULT 'players'
    CHECK (visibility IN ('gm','players','restricted')),

  restricted_json TEXT,

  -- availability window
  available_from TEXT,                      -- ISO string, null = immediately
  available_until TEXT,                     -- ISO string, null = no expiry

  auto_fail_on_expire INTEGER NOT NULL DEFAULT 0
    CHECK (auto_fail_on_expire IN (0,1)),

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_vault_user_id TEXT,
  updated_by_vault_user_id TEXT,
  deleted_at TEXT,

  -- window integrity (only if both set)
  CHECK (
    available_from IS NULL
    OR available_until IS NULL
    OR available_from <= available_until
  ),

  FOREIGN KEY (template_id) REFERENCES quest_templates(id),
  FOREIGN KEY (created_by_vault_user_id) REFERENCES vault_users(id) ON DELETE SET NULL,
  FOREIGN KEY (updated_by_vault_user_id) REFERENCES vault_users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_quest_world ON quests(world_id);
CREATE INDEX IF NOT EXISTS idx_quest_world_status ON quests(world_id, status);

-- availability queries (e.g. show available now, show expiring soon)
CREATE INDEX IF NOT EXISTS idx_quest_world_available_until
  ON quests(world_id, available_until);

CREATE INDEX IF NOT EXISTS idx_quest_world_available_from
  ON quests(world_id, available_from);

/* =========================================================
 *  ASSIGNMENTS (includes timers / duration)
 * ========================================================= */
CREATE TABLE IF NOT EXISTS quest_assignments (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL,
  quest_id TEXT NOT NULL,

  scope TEXT NOT NULL
    CHECK (scope IN ('party','actor')),

  actor_id TEXT,

  assigned_at TEXT NOT NULL,
  assigned_by_vault_user_id TEXT,

  -- timer state
  started_at TEXT,                        -- null until started
  duration_seconds INTEGER
    CHECK (duration_seconds IS NULL OR duration_seconds >= 0),

  expected_complete_at TEXT,              -- derived from started_at + duration_seconds
  time_status TEXT NOT NULL DEFAULT 'idle'
    CHECK (time_status IN ('idle','running','paused','complete','expired','failed')),

  deleted_at TEXT,

  -- scope integrity: actor scope requires actor_id; party scope must not require it
  CHECK (
    (scope = 'party' AND (actor_id IS NULL OR actor_id = ''))
    OR
    (scope = 'actor' AND actor_id IS NOT NULL AND actor_id <> '')
  ),

  -- expected_complete_at integrity
  CHECK (
    -- if missing started/duration, expected must be null
    ((started_at IS NULL OR duration_seconds IS NULL) AND expected_complete_at IS NULL)
    OR
    -- if both are present, expected must be present
    (started_at IS NOT NULL AND duration_seconds IS NOT NULL AND expected_complete_at IS NOT NULL)
  ),

  FOREIGN KEY (quest_id) REFERENCES quests(id) ON DELETE CASCADE,
  FOREIGN KEY (assigned_by_vault_user_id) REFERENCES vault_users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_qassign_world ON quest_assignments(world_id);
CREATE INDEX IF NOT EXISTS idx_qassign_quest ON quest_assignments(quest_id);
CREATE INDEX IF NOT EXISTS idx_qassign_world_scope ON quest_assignments(world_id, scope, actor_id);

-- fast overdue scan (running timers past expected_complete_at)
CREATE INDEX IF NOT EXISTS idx_qassign_world_overdue
  ON quest_assignments(world_id, time_status, expected_complete_at);
/* =========================================================
 *  TRIGGERS: expected_complete_at maintenance
 * ========================================================= */

-- After INSERT: compute expected_complete_at if we have started + duration
CREATE TRIGGER IF NOT EXISTS trg_qassign_expected_after_insert
AFTER INSERT ON quest_assignments
FOR EACH ROW
WHEN NEW.started_at IS NOT NULL AND NEW.duration_seconds IS NOT NULL
BEGIN
  UPDATE quest_assignments
  SET expected_complete_at = datetime(NEW.started_at, '+' || NEW.duration_seconds || ' seconds')
  WHERE id = NEW.id;
END;

-- After UPDATE of started_at or duration_seconds: recompute (or null it out)
CREATE TRIGGER IF NOT EXISTS trg_qassign_expected_after_update
AFTER UPDATE OF started_at, duration_seconds ON quest_assignments
FOR EACH ROW
BEGIN
  UPDATE quest_assignments
  SET expected_complete_at =
    CASE
      WHEN NEW.started_at IS NOT NULL AND NEW.duration_seconds IS NOT NULL
        THEN datetime(NEW.started_at, '+' || NEW.duration_seconds || ' seconds')
      ELSE NULL
    END
  WHERE id = NEW.id;
END;

/* =========================================================
 *  INTEL
 * ========================================================= */
CREATE TABLE IF NOT EXISTS intel (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL, -- note|map|image|handout|...
  summary TEXT,
  body TEXT,
  tags_json TEXT,
  scope TEXT NOT NULL DEFAULT 'party', -- party|player
  actor_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'players', -- gm|players|restricted
  restricted_json TEXT,
  discovered_at TEXT,
  discovered_by_actor_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_vault_user_id TEXT,
  updated_by_vault_user_id TEXT,
  deleted_at TEXT,
  FOREIGN KEY (created_by_vault_user_id) REFERENCES vault_users(id) ON DELETE SET NULL,
  FOREIGN KEY (updated_by_vault_user_id) REFERENCES vault_users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_intel_world ON intel(world_id);
CREATE INDEX IF NOT EXISTS idx_intel_world_kind ON intel(world_id, kind);
CREATE INDEX IF NOT EXISTS idx_intel_world_scope ON intel(world_id, scope, actor_id);

CREATE TABLE IF NOT EXISTS intel_attachments (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL,
  intel_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  caption TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (intel_id) REFERENCES intel(id) ON DELETE CASCADE,
  FOREIGN KEY (media_id) REFERENCES media_objects(id)
);

CREATE INDEX IF NOT EXISTS idx_intel_attach_intel ON intel_attachments(intel_id, sort_order);

/* =========================================================
 *  FOUNDY MIRRORS (journal mapping)
 * ========================================================= */
CREATE TABLE IF NOT EXISTS foundry_journal_mirrors (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL,
  entity_type TEXT NOT NULL, -- quest|intel
  entity_id TEXT NOT NULL,
  pack_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  last_pushed_at TEXT,
  last_seen_at TEXT,
  last_hash TEXT,
  UNIQUE (world_id, entity_type, entity_id),
  UNIQUE (world_id, pack_id, doc_id)
);

CREATE INDEX IF NOT EXISTS idx_mirror_entity ON foundry_journal_mirrors(world_id, entity_type, entity_id);

/* =========================================================
 *  Legacy/simple parent-child quest links (optional)
 * ========================================================= */
CREATE TABLE IF NOT EXISTS quest_links (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL,

  parent_quest_id TEXT NOT NULL,
  child_quest_id  TEXT NOT NULL,

  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,

  UNIQUE (world_id, parent_quest_id, child_quest_id),

  FOREIGN KEY (parent_quest_id) REFERENCES quests(id) ON DELETE CASCADE,
  FOREIGN KEY (child_quest_id)  REFERENCES quests(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_quest_links_world_parent
  ON quest_links(world_id, parent_quest_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_quest_links_world_child
  ON quest_links(world_id, child_quest_id);

/* =========================================================
 *  Quest objectives (definition)
 * ========================================================= */
CREATE TABLE IF NOT EXISTS quest_objectives (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL,
  quest_id TEXT NOT NULL,

  key TEXT, -- stable identifier per quest (optional)
  title TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  required INTEGER NOT NULL DEFAULT 1, -- 0/1

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,

  UNIQUE (world_id, quest_id, key),

  FOREIGN KEY (quest_id) REFERENCES quests(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_quest_objectives_world_quest
  ON quest_objectives(world_id, quest_id, sort_order);

/* =========================================================
 *  Objective state per assignment (progress / completion)
 * ========================================================= */
CREATE TABLE IF NOT EXISTS quest_objective_states (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL,

  objective_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'open', -- open|complete|failed|skipped
  progress_current INTEGER NOT NULL DEFAULT 0,
  progress_max INTEGER,               -- null means boolean objective

  note TEXT,
  updated_at TEXT NOT NULL,

  UNIQUE (objective_id, assignment_id),

  FOREIGN KEY (objective_id) REFERENCES quest_objectives(id) ON DELETE CASCADE,
  FOREIGN KEY (assignment_id) REFERENCES quest_assignments(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_qos_world_assignment
  ON quest_objective_states(world_id, assignment_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_qos_world_objective
  ON quest_objective_states(world_id, objective_id, updated_at);

/* =========================================================
 *  NEW: Quest chains for vue-flow (graph: nodes + edges + layout)
 * ========================================================= */
CREATE TABLE IF NOT EXISTS quest_chains (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL,

  title TEXT NOT NULL,
  summary TEXT,
  tags_json TEXT,

  status TEXT NOT NULL DEFAULT 'draft', -- draft|published|archived

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_vault_user_id TEXT,
  updated_by_vault_user_id TEXT,
  deleted_at TEXT,

  FOREIGN KEY (created_by_vault_user_id) REFERENCES vault_users(id) ON DELETE SET NULL,
  FOREIGN KEY (updated_by_vault_user_id) REFERENCES vault_users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_qchain_world ON quest_chains(world_id);
CREATE INDEX IF NOT EXISTS idx_qchain_world_status ON quest_chains(world_id, status);

CREATE TABLE IF NOT EXISTS quest_chain_nodes (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL,
  chain_id TEXT NOT NULL,

  quest_id TEXT NOT NULL,

  -- vue-flow layout
  pos_x REAL NOT NULL DEFAULT 0,
  pos_y REAL NOT NULL DEFAULT 0,

  -- optional node config for UI
  ui_json TEXT,

  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,

  UNIQUE (world_id, chain_id, quest_id),

  FOREIGN KEY (chain_id) REFERENCES quest_chains(id) ON DELETE CASCADE,
  FOREIGN KEY (quest_id) REFERENCES quests(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_qchain_nodes_chain
  ON quest_chain_nodes(world_id, chain_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_qchain_nodes_quest
  ON quest_chain_nodes(world_id, quest_id);

CREATE TABLE IF NOT EXISTS quest_chain_edges (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL,
  chain_id TEXT NOT NULL,

  from_quest_id TEXT NOT NULL,
  to_quest_id   TEXT NOT NULL,

  -- gating / rules
  gate_mode TEXT NOT NULL DEFAULT 'all',      -- all|any (future: expr)
  condition_json TEXT,                        -- future: expression-based gating
  auto_assign INTEGER NOT NULL DEFAULT 0,     -- 0/1 (auto-assign child when unlocked)

  -- timers on the edge (delay unlock after parent completes)
  delay_seconds INTEGER NOT NULL DEFAULT 0 CHECK (delay_seconds >= 0),  

  -- vue-flow edge UI
  ui_json TEXT,

  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,

  UNIQUE (world_id, chain_id, from_quest_id, to_quest_id),

  FOREIGN KEY (chain_id) REFERENCES quest_chains(id) ON DELETE CASCADE,
  FOREIGN KEY (from_quest_id) REFERENCES quests(id) ON DELETE CASCADE,
  FOREIGN KEY (to_quest_id)   REFERENCES quests(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_qchain_edges_chain
  ON quest_chain_edges(world_id, chain_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_qchain_edges_from
  ON quest_chain_edges(world_id, from_quest_id);

CREATE INDEX IF NOT EXISTS idx_qchain_edges_to
  ON quest_chain_edges(world_id, to_quest_id);

  CREATE TABLE IF NOT EXISTS foundry_chat_cursors (
  world_id  TEXT NOT NULL,
  day       TEXT NOT NULL,   -- YYYY-MM-DD (UTC)
  hour      TEXT NOT NULL,   -- "00".."23"
  after_ts  INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (world_id, day, hour)
);

CREATE INDEX IF NOT EXISTS idx_foundry_chat_cursors_world
  ON foundry_chat_cursors(world_id);

/* =========================================================
 *  VENDORS
 * ========================================================= */
CREATE TABLE IF NOT EXISTS vendors (
  id          TEXT PRIMARY KEY,
  world_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  avatar_url  TEXT,
  npc_name    TEXT,
  greetings   TEXT NOT NULL DEFAULT '[]',
  gold        INTEGER NOT NULL DEFAULT 0,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_by  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  FOREIGN KEY (created_by) REFERENCES vault_users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_vendors_world ON vendors(world_id);

CREATE TABLE IF NOT EXISTS vendor_items (
  id                       TEXT PRIMARY KEY,
  vendor_id                TEXT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  world_id                 TEXT NOT NULL,
  name                     TEXT NOT NULL,
  description              TEXT,
  image_url                TEXT,
  foundry_item_id          TEXT,             -- Foundry Item._id for inventory push
  price_gold               INTEGER NOT NULL DEFAULT 0,
  quantity                 INTEGER NOT NULL DEFAULT 0,    -- current stock (DB-committed)
  max_quantity             INTEGER NOT NULL DEFAULT 0,    -- cap (0 = unlimited/finite but no restock cap)
  restock_interval_seconds INTEGER NOT NULL DEFAULT 0,    -- 0 = no auto-restock
  restock_amount           INTEGER NOT NULL DEFAULT 1,    -- units restored per interval
  last_restocked_at        INTEGER NOT NULL DEFAULT 0,    -- epoch ms of last committed restock
  sort_order               INTEGER NOT NULL DEFAULT 0,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vendor_items_vendor ON vendor_items(vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendor_items_world  ON vendor_items(world_id);

CREATE TABLE IF NOT EXISTS vendor_transactions (
  id                   TEXT PRIMARY KEY,
  vendor_id            TEXT NOT NULL,
  world_id             TEXT NOT NULL,
  item_id              TEXT NOT NULL,
  item_name            TEXT NOT NULL,
  buyer_actor_id       TEXT,
  buyer_vault_user_id  TEXT,
  quantity             INTEGER NOT NULL DEFAULT 1,
  gold_spent           INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vendor_tx_world  ON vendor_transactions(world_id);
CREATE INDEX IF NOT EXISTS idx_vendor_tx_vendor ON vendor_transactions(vendor_id);

    `);
    // ---- schema upgrades for existing DBs ----
    ensureColumn("vault_users", "display_name", `ALTER TABLE vault_users ADD COLUMN display_name TEXT;`);
    ensureColumn("vault_users", "username", `ALTER TABLE vault_users ADD COLUMN username TEXT;`);
    db.exec(`
    UPDATE vault_users
    SET username = lower(
      CASE
        WHEN email IS NOT NULL AND length(trim(email)) > 0 THEN
          substr(
            trim(email),
            1,
            CASE
              WHEN instr(trim(email), '@') > 0 THEN instr(trim(email), '@') - 1
              ELSE length(trim(email))
            END
          )
        ELSE 'user_' || substr(id, 1, 8)
      END
    )
    WHERE username IS NULL OR trim(username) = '';
  `);
    db.exec(`
    UPDATE vault_users
    SET username = username || '_' || substr(id, 1, 6)
    WHERE username IN (
      SELECT username
      FROM vault_users
      WHERE username IS NOT NULL
      GROUP BY username
      HAVING COUNT(*) > 1
    );
  `);
    db.exec(`
    UPDATE vault_users
    SET username = 'user_' || substr(id, 1, 8)
    WHERE username IS NULL OR trim(username) = '';
  `);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_users_username ON vault_users(username);`);
    ensureColumn("quests", "category", `ALTER TABLE quests ADD COLUMN category TEXT;`);
    // (optional but harmless) ensure reward_json exists too:
    ensureColumn("quests", "reward_json", `ALTER TABLE quests ADD COLUMN reward_json TEXT;`);
    ensureColumn("quest_templates", "category", `ALTER TABLE quest_templates ADD COLUMN category TEXT;`);
    ensureColumn("quest_templates", "reward_json", `ALTER TABLE quest_templates ADD COLUMN reward_json TEXT;`);
    // vendor greetings (added 2026-03)
    ensureColumn("vendors", "greetings", `ALTER TABLE vendors ADD COLUMN greetings TEXT NOT NULL DEFAULT '[]';`);
    // vendor npc name (added 2026-03)
    ensureColumn("vendors", "npc_name", `ALTER TABLE vendors ADD COLUMN npc_name TEXT;`);
}
//# sourceMappingURL=db.js.map