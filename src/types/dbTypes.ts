// src/services/dbTypes.ts

/** ---------------------------------------
 * Shared primitives
 * -------------------------------------- */

export type ISODateTimeString = string; // stored as TEXT
export type EpochMs = number;           // stored as INTEGER

export type SoftDelete = {
  deleted_at?: ISODateTimeString | null;
};

/** JSON columns are stored as TEXT in sqlite. */
export type JsonText = string | null;

/** Common visibility pattern */
export type Visibility = "gm" | "players" | "restricted";

/** World membership roles */
export type WorldRole = "dm" | "player" | "observer";

/** Actor link permission */
export type ActorPermission = "owner" | "editor" | "viewer";

/** ---------------------------------------
 * vault_users
 * -------------------------------------- */
export type VaultUserRow = {
  id: string;
  username: string;
  email: string | null;
  password_hash: string | null;
  must_reset_password: 0 | 1;
  is_superadmin: 0 | 1;
  created_at: ISODateTimeString;
  updated_at: ISODateTimeString;
};

/** ---------------------------------------
 * world_user_links
 * -------------------------------------- */
export type WorldUserLinkRow = {
  vault_user_id: string;
  world_id: string;
  foundry_user_id: string | null;
  role: WorldRole; // stored as TEXT
  linked_at: ISODateTimeString;
};

/** ---------------------------------------
 * invites
 * -------------------------------------- */
export type InviteRow = {
  id: string;
  world_id: string;
  foundry_user_id: string;
  display_name: string | null;
  role: WorldRole; // stored as TEXT
  code_hash: string;
  created_by_vault_user_id: string;
  created_at: ISODateTimeString;
  expires_at: ISODateTimeString | null;
  max_uses: number; // INTEGER
  uses: number;     // INTEGER
  revoked: 0 | 1;   // INTEGER
};

/** ---------------------------------------
 * world_actor_links
 * -------------------------------------- */
export type WorldActorLinkRow = {
  world_id: string;
  actor_id: string;
  vault_user_id: string;
  permission: ActorPermission; // TEXT
  linked_at: ISODateTimeString;
};

/** ---------------------------------------
 * password_reset_tokens
 * -------------------------------------- */
export type PasswordResetTokenRow = {
  id: string;
  vault_user_id: string;
  token_hash: string;
  created_at: ISODateTimeString;
  expires_at: ISODateTimeString;
  used_at: ISODateTimeString | null;
  created_by_vault_user_id: string | null;
};

/** ---------------------------------------
 * log_events
 * -------------------------------------- */
export type EventSource = "foundry" | "vaulthero" | (string & {});
export type EventKind =
  | "chat"
  | "roll"
  | "attack"
  | "damage"
  | "hp"
  | "system"
  | "note"
  | "other"
  | (string & {});

export type LogEventRow = {
  id: string;
  world_id: string;
  ts: EpochMs;
  source: EventSource;
  kind: EventKind;

  actor_id: string | null;
  actor_name: string | null;

  title: string | null;
  summary: string | null;
  html: string | null;

  group_id: string | null;
  data_json: JsonText;
};

/** ---------------------------------------
 * foundry_chat_cursor
 * -------------------------------------- */
export type FoundryChatCursorRow = {
  worldId: string;
  day: string;   // YYYY-MM-DD
  hour: string;  // "0".."23"
  afterTs: EpochMs;  // INTEGER
  updatedAt: EpochMs;
};

/** ---------------------------------------
 * media_objects
 * -------------------------------------- */
export type MediaStorage = "vault" | (string & {});
export type MediaObjectRow = {
  id: string;
  world_id: string;

  kind: string; // "avatar" | "intel" | "map" | ...
  filename: string;
  mime_type: string | null;
  byte_size: number | null;
  sha256: string | null;

  storage: MediaStorage; // default 'vault'
  path: string;

  created_at: ISODateTimeString;
  created_by_vault_user_id: string | null;
  deleted_at: ISODateTimeString | null;
};

/** ---------------------------------------
 * quest_templates
 * -------------------------------------- */

export type QuestTags = string[]; // stored as tags_json
export type QuestReward = Record<string, any>; // you can tighten later

export type QuestTemplateRow = {
  id: string;
  world_id: string;

  title: string;
  summary: string | null;
  body: string | null;
  category: string | null;
  tags_json: JsonText;    // QuestTags JSON
  reward_json: JsonText;  // QuestReward JSON

  created_at: ISODateTimeString;
  updated_at: ISODateTimeString;

  created_by_vault_user_id: string | null;
  updated_by_vault_user_id: string | null;

  deleted_at: ISODateTimeString | null;
};

/** ---------------------------------------
 * quests
 * -------------------------------------- */

export type QuestStatus =
  | "draft"
  | "active"
  | "completed"
  | "failed"
  | "archived"
  | (string & {});

export type QuestRestricted = {
  // use for "restricted_json" when visibility === "restricted"
  actorIds?: string[];
  userIds?: string[];
  note?: string;
};

export type QuestRow = {
  id: string;
  world_id: string;

  template_id: string | null;

  category: string | null;      // <-- ADD THIS
  reward_json: JsonText;        // QuestReward JSON

  title: string;
  summary: string | null;
  body: string | null;

  status: QuestStatus;          // default 'active'
  priority: number;             // INTEGER
  tags_json: JsonText;          // QuestTags JSON

  visibility: Visibility;       // gm|players|restricted
  restricted_json: JsonText;    // QuestRestricted JSON

  // timers / windows
  available_from: ISODateTimeString | null;
  available_until: ISODateTimeString | null;
  auto_fail_on_expire: 0 | 1;

  created_at: ISODateTimeString;
  updated_at: ISODateTimeString;

  created_by_vault_user_id: string | null;
  updated_by_vault_user_id: string | null;

  deleted_at: ISODateTimeString | null;
};

/** ---------------------------------------
 * quest_assignments
 * -------------------------------------- */

export type QuestAssignmentScope = "party" | "actor" | (string & {});

export type QuestTimeStatus =
  | "idle"
  | "running"
  | "paused"
  | "complete"
  | "expired"
  | "failed"
  | (string & {});

export type QuestAssignmentRow = {
  id: string;
  world_id: string;
  quest_id: string;

  scope: QuestAssignmentScope;  // party|actor
  actor_id: string | null;      // required if scope==='actor'

  assigned_at: ISODateTimeString;
  assigned_by_vault_user_id: string | null;

  // timers / runtime state
  started_at: ISODateTimeString | null;
  duration_seconds: number | null;
  expected_complete_at: ISODateTimeString | null;
  time_status: QuestTimeStatus; // default 'idle'

  deleted_at: ISODateTimeString | null;
};

/** ---------------------------------------
 * intel
 * -------------------------------------- */

export type IntelKind =
  | "note"
  | "map"
  | "image"
  | "handout"
  | "lore"
  | "rumor"
  | (string & {});

export type IntelScope = "party" | "player" | (string & {});

export type IntelRestricted = {
  actorIds?: string[];
  userIds?: string[];
  note?: string;
};

export type IntelTags = string[];

export type IntelRow = {
  id: string;
  world_id: string;

  title: string;
  kind: IntelKind;

  summary: string | null;
  body: string | null;

  tags_json: JsonText; // IntelTags JSON

  scope: IntelScope;       // party|player
  actor_id: string | null; // if scope=player, which actor

  visibility: Visibility;
  restricted_json: JsonText; // IntelRestricted JSON

  discovered_at: ISODateTimeString | null;
  discovered_by_actor_id: string | null;

  created_at: ISODateTimeString;
  updated_at: ISODateTimeString;

  created_by_vault_user_id: string | null;
  updated_by_vault_user_id: string | null;

  deleted_at: ISODateTimeString | null;
};

/** ---------------------------------------
 * intel_attachments
 * -------------------------------------- */
export type IntelAttachmentRow = {
  id: string;
  world_id: string;

  intel_id: string;
  media_id: string;

  caption: string | null;
  sort_order: number; // INTEGER

  created_at: ISODateTimeString;
  deleted_at: ISODateTimeString | null;
};

/** ---------------------------------------
 * foundry_journal_mirrors
 * -------------------------------------- */
export type MirrorEntityType = "quest" | "intel" | (string & {});
export type FoundryJournalMirrorRow = {
  id: string;
  world_id: string;

  entity_type: MirrorEntityType; // quest|intel
  entity_id: string;

  pack_id: string;
  doc_id: string;

  last_pushed_at: ISODateTimeString | null;
  last_seen_at: ISODateTimeString | null;
  last_hash: string | null;
};

/** ---------------------------------------
 * quest_links (legacy/simple parent-child)
 * -------------------------------------- */
export type QuestLinkRow = {
  id: string;
  world_id: string;

  parent_quest_id: string;
  child_quest_id: string;

  sort_order: number; // INTEGER
  created_at: ISODateTimeString;
};

/** ---------------------------------------
 * quest_objectives
 * -------------------------------------- */
export type QuestObjectiveRow = {
  id: string;
  world_id: string;
  quest_id: string;

  key: string | null; // stable identifier within quest
  title: string;
  description: string | null;
  sort_order: number; // INTEGER

  required: 0 | 1;

  created_at: ISODateTimeString;
  updated_at: ISODateTimeString;

  deleted_at: ISODateTimeString | null;
};

/** ---------------------------------------
 * quest_objective_states (per assignment)
 * -------------------------------------- */
export type ObjectiveStatus =
  | "open"
  | "complete"
  | "failed"
  | "skipped"
  | (string & {});

export type QuestObjectiveStateRow = {
  id: string;
  world_id: string;

  objective_id: string;
  assignment_id: string;

  status: ObjectiveStatus;

  progress_current: number; // INTEGER
  progress_max: number | null; // null => boolean objective

  note: string | null;
  updated_at: ISODateTimeString;
};

/** ---------------------------------------
 * quest_chains (vue-flow graph container)
 * -------------------------------------- */
export type QuestChainStatus = "draft" | "published" | "archived" | (string & {});
export type QuestChainRow = {
  id: string;
  world_id: string;

  title: string;
  summary: string | null;
  tags_json: JsonText;

  status: QuestChainStatus;

  created_at: ISODateTimeString;
  updated_at: ISODateTimeString;

  created_by_vault_user_id: string | null;
  updated_by_vault_user_id: string | null;

  deleted_at: ISODateTimeString | null;
};

/** ---------------------------------------
 * quest_chain_nodes (vue-flow nodes + positions)
 * -------------------------------------- */
export type QuestChainNodeUI = Record<string, any>;
export type QuestChainNodeRow = {
  id: string;
  world_id: string;
  chain_id: string;

  quest_id: string;

  pos_x: number; // REAL
  pos_y: number; // REAL

  ui_json: JsonText; // QuestChainNodeUI JSON

  sort_order: number; // INTEGER
  created_at: ISODateTimeString;
  updated_at: ISODateTimeString;

  deleted_at: ISODateTimeString | null;
};

/** ---------------------------------------
 * quest_chain_edges (vue-flow edges + gating + delay)
 * -------------------------------------- */
export type EdgeGateMode = "all" | "any" | (string & {});
export type QuestChainEdgeCondition = Record<string, any>;
export type QuestChainEdgeUI = Record<string, any>;

export type QuestChainEdgeRow = {
  id: string;
  world_id: string;
  chain_id: string;

  from_quest_id: string;
  to_quest_id: string;

  gate_mode: EdgeGateMode;      // default 'all'
  condition_json: JsonText;     // QuestChainEdgeCondition JSON
  auto_assign: 0 | 1;           // default 0

  delay_seconds: number;        // INTEGER default 0

  ui_json: JsonText;            // QuestChainEdgeUI JSON

  sort_order: number;           // INTEGER
  created_at: ISODateTimeString;
  updated_at: ISODateTimeString;

  deleted_at: ISODateTimeString | null;
};

/** ---------------------------------------
 * Convenience unions (all rows)
 * -------------------------------------- */
export type AnyDbRow =
  | VaultUserRow
  | WorldUserLinkRow
  | InviteRow
  | WorldActorLinkRow
  | PasswordResetTokenRow
  | LogEventRow
  | FoundryChatCursorRow
  | MediaObjectRow
  | QuestTemplateRow
  | QuestRow
  | QuestAssignmentRow
  | IntelRow
  | IntelAttachmentRow
  | FoundryJournalMirrorRow
  | QuestLinkRow
  | QuestObjectiveRow
  | QuestObjectiveStateRow
  | QuestChainRow
  | QuestChainNodeRow
  | QuestChainEdgeRow;
