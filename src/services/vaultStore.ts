// @ts-nocheck
import path from "node:path";
import fs from "node:fs/promises";
import { config } from "../config.js";
import { createLogger } from "./logger.js";

const logger = createLogger(
  (process.env.LOG_LEVEL as any) ?? "info"
);
export type WorldId = string;

export type WorldOnlineStatus = {
  worldId: string;
  online: boolean;
  lastHeartbeatAt?: string;
  ageMs?: number;
  details?: any;
};

export type CommandType =
  // Actors
  | "actor.create"
  | "actor.update"
  | "actor.delete"
  | "actor.levelUp"
  | "actor.item.add"
  | "actor.item.update"
  | "actor.item.delete"

  // Quests (journal-backed or compendium-backed)
  | "quest.create"
  | "quest.update"
  | "quest.delete"
  | "quest.assign"
  | "quest.unassign"
  | "quest.complete"

  // Intel
  | "intel.create"
  | "intel.update"
  | "intel.delete"
  | "intel.assign"
  | "intel.unassign";

export type CommandReturn = {
  actor?: boolean;        // return updated actor snapshot
  actorId?: boolean;      // return created actorId
  quest?: boolean;        // return updated quest payload
  intel?: boolean;        // return updated intel payload
  items?: boolean;        // return updated items (if you implement)
};

export type VaultCommandEnvelope = {
  schema: "vaultsync.command.v1";
  requestId: string;
  ts?: number;

  worldId?: string;
  type: CommandType;     // ✅ now typed
  version: number;
  actorId?: string;

  user?: {
    appUserId?: string;
    foundryUserId?: string;
  };

  payload: any;

  ifMatch?: {
    actorUpdatedAt?: string; // optimistic lock for actor writes
    questUpdatedAt?: string;
    intelUpdatedAt?: string;
  };

  return?: CommandReturn;
};

export type ChatOp = "create" | "update" | "delete";

export type ChatEventEnvelope<TMessage = any> = {
  op: ChatOp;
  ts: number;
  id: string;
  message?: TMessage;
};

export type ChatShardKey = {
  day: string;  // YYYY-MM-DD
  hour: string; // HH (00-23)
};

export type ListChatEventsOptions = {
  afterTs?: number;        // exclusive
  limit?: number;          // max events returned
};

export type ListChatEventsResult<TMessage = any> = {
  events: Array<ChatEventEnvelope<TMessage>>;
  nextAfterTs: number;
};

export type JournalPayload = {
  schema: "vaultsync.journal.payload.v1";
  worldId: string;
  pack: string;
  docId: string;
  uuid: string;
  name: string;
  flags?: any;
  pages?: any[];
  generatedAt: string;
};

export type DeleteManifest = {
  schema: "vaultsync.delete-manifest.v1";
  worldId: string;
  generatedAt: string;
  keep: string[];
  delete: string[];
};

export function safeId(id: string): string {
  // Must match vault-sync safeId() exactly (filenames must line up)
  return String(id ?? "unknown").replace(/[^a-zA-Z0-9_-]/g, "");
}



export class VaultStore {
  /**
   * @param dataRoot Absolute path to Foundry UserData root (or wherever `vault/` lives).
   * Example: /path/to/FoundryVTT/Data
   */
  constructor(private dataRoot: string) {}

  /* -------------------------------------------- */
  /* Core path helpers (safe)                     */
  /* -------------------------------------------- */

  /** Join and ensure the result stays within dataRoot (prevents traversal). */
  private abs(rel: string): string {
    const cleaned = String(rel ?? "").replace(/^\/+/, ""); // force relative
    const out = path.resolve(this.dataRoot, cleaned);
    const root = path.resolve(this.dataRoot);

    if (!out.startsWith(root + path.sep) && out !== root) {
      throw new Error(`VaultStore: path escapes root: ${rel}`);
    }
    return out;
  }

  worldRoot(worldId: WorldId): string {
    return `worlds/${worldId}`;
  }

  /** App-owned root (VaultSync writes here) */
  vaultRoot(worldId: WorldId): string {
    return `${this.worldRoot(worldId)}/vaultsync`;
  }

  /** App-owned meta */
  private metaDir(worldId: WorldId): string {
    return `${this.vaultRoot(worldId)}/meta`;
  }

  /** App-owned requests */
  private requestsDir(worldId: WorldId): string {
    return `${this.vaultRoot(worldId)}/requests`;
  }

  /* -------------------------------------------- */
  /* Generic fs helpers                           */
  /* -------------------------------------------- */

  private async listFilesSafe(rel: string): Promise<string[]> {
    try {
      return await this.listFiles(rel);
    } catch {
      return [];
    }
  }

  private parseVersionedTs(name: string, base: string): number | null {
    // base.ts.suffix.json
    if (!name.startsWith(base + ".")) return null;
    if (!name.endsWith(".json")) return null;
    const parts = name.split(".");
    if (parts.length < 4) return null;
    const ts = Number(parts[parts.length - 3]);
    return Number.isFinite(ts) ? ts : null;
  }

  private async readLatestVersionedJsonInDir<T = any>(dirRel: string, baseName: string): Promise<T | null> {
    const files = await this.listFilesSafe(dirRel);
    let best: { f: string; ts: number } | null = null;

    for (const f of files) {
      const ts = this.parseVersionedTs(f, baseName);
      if (ts == null) continue;
      if (!best || ts > best.ts) best = { f, ts };
    }

    if (!best) return null;
    return this.readJson<T>(`${dirRel}/${best.f}`);
  }

  /**
   * Back-compat: try versioned latest first, then fall back to single file.
   */
  private async readJsonLatestOrSingle<T = any>(
    dirRel: string,
    baseName: string
  ): Promise<T | null> {
    const v = await this.readLatestVersionedJsonInDir<T>(dirRel, baseName);
    if (v !== null) return v;

    const single = `${dirRel}/${baseName}.json`;
    return (await this.exists(single)) ? this.readJson<T>(single) : null;
  }

  async exists(rel: string): Promise<boolean> {
    try {
      await fs.access(this.abs(rel));
      return true;
    } catch {
      return false;
    }
  }

  async readText(rel: string): Promise<string> {
    return fs.readFile(this.abs(rel), "utf-8");
  }

  async readJson<T = any>(rel: string): Promise<T> {
    const txt = await this.readText(rel);
    return JSON.parse(txt) as T;
  }

  async writeText(rel: string, text: string): Promise<void> {
    const file = this.abs(rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, "utf-8");
  }

  async writeJson(rel: string, data: unknown): Promise<void> {
    await this.writeText(rel, JSON.stringify(data, null, 2));
  }

  /** Compatibility: newline-delimited JSON append (server-side filesystem append). */
  async appendJsonl(rel: string, obj: unknown): Promise<void> {
    const file = this.abs(rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const line = JSON.stringify(obj) + "\n";
    await fs.appendFile(file, line, "utf-8");
  }

  async deleteFile(rel: string): Promise<void> {
    try {
      await fs.unlink(this.abs(rel));
    } catch {
      // ignore missing
    }
  }

  async listDirs(rel: string): Promise<string[]> {
    const entries = await fs.readdir(this.abs(rel), { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  }

  async listFiles(rel: string): Promise<string[]> {
    const entries = await fs.readdir(this.abs(rel), { withFileTypes: true });
    return entries.filter(e => e.isFile()).map(e => e.name);
  }

  async cleanupDocRequestFromAck(worldId: WorldId, ack: any): Promise<void> {
    // Prefer the explicit path written by vault-sync
    const requestPath = typeof ack?.requestPath === "string" ? ack.requestPath : null;
    const requestFile = typeof ack?.requestFile === "string" ? ack.requestFile : null;

    // If vault-sync wrote an absolute-ish vault path like "vault/worlds/..." strip leading "vault/"
    // because VaultStore.abs() is rooted at the Foundry data root.
    const normalizeRel = (p: string) => String(p).replace(/^\/+/, "").replace(/^vault\//, "");

    // Determine request rel path
    let rel: string | null = null;

    if (requestPath) rel = normalizeRel(requestPath);
    else if (requestFile) rel = `${this.docRequestDir(worldId)}/${requestFile}`;

    if (!rel) return;

    // Safety: only delete inside this world's request dir
    const prefix = this.docRequestDir(worldId) + "/";
    if (!rel.startsWith(prefix)) {
      logger.warn("docs.cleanup refused (path outside request dir)", { worldId, rel, prefix });
      return;
    }

    await this.deleteFile(rel);
    logger.info("docs.cleanup deleted request", { worldId, rel });
  }

  /* -------------------------------------------- */
  /* World scaffolding (compat + tests)           */
  /* -------------------------------------------- */

  /**
   * Ensure a world's vault folder layout exists.
   * Useful for tests/dev or if you ever run api against an empty world root.
   */
async ensureWorldScaffold(worldId: WorldId): Promise<void> {
  const w = this.worldRoot(worldId);
  const v = this.vaultRoot(worldId);

  const dirs = [
    // Foundry-native (exist in real worlds, but safe to ensure for tests)
    `${w}/data`,
    `${w}/packs`,

    // App/VaultSync-owned
    `${v}/meta`,
    `${v}/state`,
    `${v}/import`,
    `${v}/exports`,

    // Requests (new home)
    `${v}/requests/export-docs`,
    `${v}/requests/export-docs-done`,
    `${v}/requests/commands`,
    `${v}/requests/commands-done`,
    ];

    for (const d of dirs) {
      await fs.mkdir(this.abs(d), { recursive: true });
    }
  }

  /* -------------------------------------------- */
  /* World/meta                                   */
  /* -------------------------------------------- */

    async listWorldIds(): Promise<string[]> {
    const base = "worlds";
    if (!(await this.exists(base))) return [];
    return this.listDirs(base);
    }

  /** Compatibility alias (older routes often call listWorlds). */
  async listWorlds(): Promise<string[]> {
    return this.listWorldIds();
  }
  vaultSyncRoot(worldId: WorldId): string {
    return `worlds/${worldId}/vaultsync`;
  }

  async readWorldMeta(worldId: WorldId): Promise<any | null> {
    return this.readJsonLatestOrSingle(this.metaDir(worldId), "world");
  }

  async readUsersMeta(worldId: WorldId): Promise<any | null> {
    return this.readJsonLatestOrSingle(this.metaDir(worldId), "users");
  }

  async readVaultMeta(worldId: WorldId): Promise<any | null> {
    return this.readJsonLatestOrSingle(this.metaDir(worldId), "vault");
  }

  async readStatusMeta(worldId: WorldId): Promise<any | null> {
    return this.readJsonLatestOrSingle(this.metaDir(worldId), "status");
  }

  async readPolicyMeta(worldId: WorldId): Promise<any | null> {
    return this.readJsonLatestOrSingle(this.metaDir(worldId), "policy");
  }

async getWorldOnlineStatus(worldId: string): Promise<WorldOnlineStatus> {
  const status = await this.readStatusMeta(worldId);
  const last = Date.parse(status?.lastHeartbeatAt ?? "");
  const ageMs = Number.isFinite(last) ? Date.now() - last : Infinity;

  return {
    worldId,
    online: ageMs < 60_000,
    lastHeartbeatAt: status?.lastHeartbeatAt,
    ageMs: Number.isFinite(ageMs) ? ageMs : undefined,
    details: status ?? undefined
  };
}

  /* -------------------------------------------- */
  /* Actors                                       */
  /* -------------------------------------------- */

  actorPath(worldId: WorldId, actorId: string) {
    return `${this.worldRoot(worldId)}/data/actors/${actorId}.json`;
  }

  async readActor(worldId: WorldId, actorId: string): Promise<any | null> {
    const rel = this.actorPath(worldId, actorId);
    return (await this.exists(rel)) ? this.readJson(rel) : null;
  }

  async readActorsManifest(worldId: WorldId): Promise<any | null> {
    const rel = `${this.worldRoot(worldId)}/manifests/actors.json`;
    return (await this.exists(rel)) ? this.readJson(rel) : null;
  }

  /** Handy for routes: list actor file ids without reading manifest. */
  async listActorIds(worldId: WorldId): Promise<string[]> {
    const rel = `${this.worldRoot(worldId)}/actors`;
    if (!(await this.exists(rel))) return [];
    const files = await this.listFiles(rel);
    return files
      .filter(f => f.endsWith(".json"))
      .map(f => f.replace(/\.json$/i, ""))
      .sort((a, b) => a.localeCompare(b));
  }

  async readActorTombstone(worldId: WorldId, actorId: string): Promise<any | null> {
    const rel = `${this.worldRoot(worldId)}/actors/tombstones/${actorId}.json`;
    return (await this.exists(rel)) ? this.readJson(rel) : null;
  }

  /* -------------------------------------------- */
  /* Chat shards + events                         */
  /* -------------------------------------------- */

  chatShardDir(worldId: WorldId, shard: string) {
    return `${this.vaultRoot(worldId)}/chat/events/${shard.day}/${shard.hour}`;
  }
  chatShardManifestPath(worldId: WorldId, shard: string) {
    return `${this.vaultRoot(worldId)}/chat/manifests/${shard.day}/${shard.hour}.json`;
  }
  /** List all days that have chat manifests. */
  async listChatDays(worldId: WorldId): Promise<string[]> {
    const rel = `${this.worldRoot(worldId)}/chat/manifests`;
    if (!(await this.exists(rel))) return [];
    return (await this.listDirs(rel)).sort((a, b) => a.localeCompare(b));
  }

  async listChatShardHours(worldId: WorldId, day: string): Promise<string[]> {
    const rel = `${this.worldRoot(worldId)}/chat/manifests/${day}`;
    if (!(await this.exists(rel))) return [];
    const files = await this.listFiles(rel);
    return files
      .filter(f => f.endsWith(".json"))
      .map(f => f.replace(/\.json$/, ""))
      .sort((a, b) => a.localeCompare(b));
  }

  async readChatShardManifest(worldId: WorldId, shard: ChatShardKey): Promise<any | null> {
    const rel = this.chatShardManifestPath(worldId, shard);
    return (await this.exists(rel)) ? this.readJson(rel) : null;
  }


  async listChatEvents<TMessage = any>(
    worldId: WorldId,
    shard: ChatShardKey,
    opts: ListChatEventsOptions = {}
  ): Promise<ListChatEventsResult<TMessage>> {
    const afterTs = Number(opts.afterTs ?? 0);
    const limit = Math.max(1, Math.min(Number(opts.limit ?? 200), 2000));

    const dir = this.chatShardDir(worldId, shard);
    if (!(await this.exists(dir))) return { events: [], nextAfterTs: afterTs };

    // Files are named: <ts>-<op>-<id>.json
    const files = (await this.listFiles(dir))
      .filter(f => f.endsWith(".json"))
      .map(f => {
        const ts = Number(String(f).split("-")[0]) || 0;
        return { f, ts };
      })
      .filter(x => x.ts > afterTs)
      .sort((a, b) => a.ts - b.ts)
      .slice(0, limit);

    const events = await Promise.all(
      files.map(x => this.readJson<ChatEventEnvelope<TMessage>>(`${dir}/${x.f}`))
    );

    const nextAfterTs = events.length
      ? (events[events.length - 1].ts ?? afterTs)
      : afterTs;

    return { events, nextAfterTs };
  }

  /**
   * List chat export files written by VaultSync's exportChatMessage().
   *
   * VaultSync writes flat ExportRecord files to:
   *   vaultsync/exports/chat/chat.{msgId}.{epochMs}.{nonce}.json
   *
   * Each file is a VaultExportRecord:
   *   { type: "export", contractVersion: 1, docType: "ChatMessage", foundry: { ...Foundry ChatMessage... } }
   *
   * This is the correct method to use for the Foundry→VaultHero pipeline.
   * The legacy listChatEvents() reads from a different path that VaultSync
   * does not write to.
   */
  async listChatExportsFlat(
    worldId: WorldId,
    opts: { afterTs?: number; limit?: number } = {}
  ): Promise<{ events: Array<{ file: string; ts: number; raw: any }>; nextAfterTs: number }> {
    const afterTs = Number(opts.afterTs ?? 0);
    const limit = Math.max(1, Math.min(Number(opts.limit ?? 200), 2000));

    const dir = `${this.vaultRoot(worldId)}/exports/chat`;
    if (!(await this.exists(dir))) return { events: [], nextAfterTs: afterTs };

    let allFiles: string[];
    try {
      allFiles = await this.listFiles(dir);
    } catch {
      return { events: [], nextAfterTs: afterTs };
    }

    // Parse filenames: chat.{msgId}.{epochMs}.{nonce}.json
    // epochMs is at parts[parts.length - 2] after stripping .json
    const parsed: Array<{ f: string; ts: number }> = [];
    for (const f of allFiles) {
      if (!f.endsWith(".json")) continue;
      const base = f.slice(0, -5); // strip .json
      const parts = base.split(".");
      if (parts.length < 4) continue;
      const ts = Number(parts[parts.length - 2]);
      if (!Number.isFinite(ts) || ts <= 0) continue;
      if (ts > afterTs) parsed.push({ f, ts });
    }

    const sorted = parsed
      .sort((a, b) => a.ts - b.ts)
      .slice(0, limit);

    const events: Array<{ file: string; ts: number; raw: any }> = [];
    for (const x of sorted) {
      try {
        const raw = await this.readJson(`${dir}/${x.f}`);
        events.push({ file: x.f, ts: x.ts, raw });
      } catch {
        // skip unreadable files
      }
    }

    const nextAfterTs = events.length ? events[events.length - 1].ts : afterTs;
    return { events, nextAfterTs };
  }

  /* -------------------------------------------- */
  /* Documents                        */
  /* -------------------------------------------- */

  async readPacksManifest(worldId: WorldId): Promise<any | null> {
    const rel = `${this.worldRoot(worldId)}/manifests/packs.json`;
    return (await this.exists(rel)) ? this.readJson(rel) : null;
  }

  packIndexPath(worldId: WorldId, packId: string): string {
    return `${this.worldRoot(worldId)}/packs/${safeId(packId)}.index.json`;
  }

  packIndexPathCandidates(worldId: WorldId, packId: string): string[] {
    const sid = safeId(packId);

    return [
      // Layout A (flat)
      `${this.worldRoot(worldId)}/packs/${sid}.index.json`,

      // Layout B (folder)
      `${this.worldRoot(worldId)}/packs/${sid}/index.json`,

      // Optional: if you ever name it explicitly
      `${this.worldRoot(worldId)}/packs/${sid}/pack.index.json`,
    ];
  }

  async readPackIndex(worldId: WorldId, packId: string): Promise<any | null> {
    for (const rel of this.packIndexPathCandidates(worldId, packId)) {
      if (await this.exists(rel)) return this.readJson(rel);
    }
    logger.warn("readPackIndex: not found", { worldId, packId, tried: this.packIndexPathCandidates(worldId, packId) });
    return null;
  }

  async readActorDocRefsManifest(worldId: WorldId): Promise<any | null> {
    const rel = `${this.worldRoot(worldId)}/manifests/actor-doc-refs.json`;
    return (await this.exists(rel)) ? this.readJson(rel) : null;
  }

  docPath(worldId: WorldId, uuid: string): string {
    return `${this.worldRoot(worldId)}/docs/${safeId(uuid)}.json`;
  }

  async readDoc(worldId: WorldId, uuid: string): Promise<any | null> {
    const rel = this.docPath(worldId, uuid);
    return (await this.exists(rel)) ? this.readJson(rel) : null;
  }

  docRequestDir(worldId: WorldId): string {
    return `${this.requestsDir(worldId)}/export-docs`;
  }
  docDoneDir(worldId: WorldId): string {
    return `${this.requestsDir(worldId)}/export-docs-done`;
  }
  async requestDocs(worldId: WorldId, uuids: string[]): Promise<{ requestId: string }> {
    const requestId = `export-docs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const rel = `${this.docRequestDir(worldId)}/${requestId}.json`;

    await this.writeJson(rel, {
      requestId,
      uuids,
      ts: Date.now()
    });
    logger.info("docs.requestDocs", { worldId, requestId, requestPath : rel,  exists: await this.exists(rel), });
    return { requestId };
  }

  async readDocRequestAck(worldId: WorldId, requestId: string): Promise<any | null> {
    const rel = `${this.docDoneDir(worldId)}/${safeId(requestId)}.json`;
    const exists = await this.exists(rel);

    logger.info("docs.readDocRequestAck", { worldId, requestId, ackPath: rel, exists });

    if (!exists) return null;

    const ack = await this.readJson(rel);

    // Opportunistic cleanup (best-effort, ignore failures)
    try {
      await this.cleanupDocRequestFromAck(worldId, ack);
    } catch (e) {
      logger.warn("docs.cleanup failed", { worldId, requestId, err: e });
    }

    return ack;
  }
    /* -------------------------------------------- */
  /* Commands (two-way actions)                   */
  /* -------------------------------------------- */

  commandRequestDir(worldId: WorldId): string {
    return `${this.requestsDir(worldId)}/commands`;
  }
  commandDoneDir(worldId: WorldId): string {
    return `${this.requestsDir(worldId)}/commands-done`;
  }

  async enqueueCommand(
    worldId: WorldId,
    cmd: Omit<VaultCommandEnvelope, "schema" | "requestId" | "ts" | "worldId"> & { requestId?: string }
  ): Promise<{ requestId: string; requestPath: string }> {
    const requestId =
      String(cmd?.requestId ?? "").trim() ||
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const envelope: VaultCommandEnvelope = {
      schema: "vaultsync.command.v1",
      requestId,
      ts: Date.now(),
      worldId,
      type: cmd.type as any,
      version: Number(cmd.version ?? 1),
      actorId: cmd.actorId,
      user: cmd.user,
      payload: cmd.payload ?? {},
      ifMatch: cmd.ifMatch,
      return: cmd.return,
    };

    const rel = `${this.commandRequestDir(worldId)}/${safeId(requestId)}.json`;
    await this.writeJson(rel, envelope);

    logger.info("commands.enqueue", {
      worldId,
      requestId,
      type: envelope.type,
      version: envelope.version,
      requestPath: rel,
    });

    return { requestId, requestPath: rel };
  }

  async readCommandAck(worldId: WorldId, requestId: string): Promise<VaultCommandAck | null> {
    const rel = `${this.commandDoneDir(worldId)}/${safeId(requestId)}.json`;
    if (!(await this.exists(rel))) return null;

    const ack = await this.readJson<VaultCommandAck>(rel);

    try {
      await this.cleanupCommandRequestFromAck(worldId, ack);
    } catch (e) {
      logger.warn("commands.cleanup failed", { worldId, requestId, err: e });
    }

    return ack;
  }

  async cleanupCommandRequestFromAck(worldId: WorldId, ack: any): Promise<void> {
    const requestPath = typeof ack?.requestPath === "string" ? ack.requestPath : null;
    const requestFile = typeof ack?.requestFile === "string" ? ack.requestFile : null;

    const normalizeRel = (p: string) => String(p).replace(/^\/+/, "").replace(/^vault\//, "");

    let rel: string | null = null;
    if (requestPath) rel = normalizeRel(requestPath);
    else if (requestFile) rel = `${this.commandRequestDir(worldId)}/${requestFile}`;

    if (!rel) return;

    const prefix = this.commandRequestDir(worldId) + "/";
    if (!rel.startsWith(prefix)) {
      logger.warn("commands.cleanup refused (path outside request dir)", { worldId, rel, prefix });
      return;
    }

    await this.deleteFile(rel);
  }

  /* -------------------------------------------- */
  /* Actor commands                               */
  /* -------------------------------------------- */

  cmdActorCreate(worldId: WorldId, payload: any, user?: VaultCommandEnvelope["user"]) {
    return this.enqueueCommand(worldId, {
      type: "actor.create",
      version: 1,
      user,
      payload,
      return: { actor: true, actorId: true },
    });
  }

  cmdActorUpdate(
    worldId: WorldId,
    actorId: string,
    payload: any,
    opts?: { ifMatch?: VaultCommandEnvelope["ifMatch"]; user?: VaultCommandEnvelope["user"]; returnActor?: boolean }
  ) {
    return this.enqueueCommand(worldId, {
      type: "actor.update",
      version: 1,
      actorId,
      user: opts?.user,
      ifMatch: opts?.ifMatch,
      payload,
      return: { actor: opts?.returnActor ?? true },
    });
  }

  cmdActorDelete(worldId: WorldId, actorId: string, user?: VaultCommandEnvelope["user"]) {
    return this.enqueueCommand(worldId, {
      type: "actor.delete",
      version: 1,
      actorId,
      user,
      payload: {},
    });
  }

  /* -------------------------------------------- */
  /* Quest commands                               */
  /* -------------------------------------------- */

  cmdQuestCreate(worldId: WorldId, payload: any, user?: VaultCommandEnvelope["user"]) {
    return this.enqueueCommand(worldId, {
      type: "quest.create",
      version: 1,
      user,
      payload,
      return: { quest: true },
    });
  }

  cmdQuestUpdate(
    worldId: WorldId,
    payload: any,
    opts?: { ifMatch?: VaultCommandEnvelope["ifMatch"]; user?: VaultCommandEnvelope["user"] }
  ) {
    return this.enqueueCommand(worldId, {
      type: "quest.update",
      version: 1,
      user: opts?.user,
      ifMatch: opts?.ifMatch,
      payload,
      return: { quest: true },
    });
  }

  cmdQuestAssign(worldId: WorldId, actorId: string, payload: any, user?: VaultCommandEnvelope["user"]) {
    return this.enqueueCommand(worldId, {
      type: "quest.assign",
      version: 1,
      actorId,
      user,
      payload,
      return: { quest: true, actor: true },
    });
  }

  cmdQuestUnassign(worldId: WorldId, actorId: string, payload: any, user?: VaultCommandEnvelope["user"]) {
    return this.enqueueCommand(worldId, {
      type: "quest.unassign",
      version: 1,
      actorId,
      user,
      payload,
      return: { quest: true, actor: true },
    });
  }

  cmdQuestDelete(worldId: WorldId, payload: any, user?: VaultCommandEnvelope["user"]) {
    return this.enqueueCommand(worldId, {
      type: "quest.delete",
      version: 1,
      user,
      payload,
    });
  }

  /* -------------------------------------------- */
  /* Intel commands                               */
  /* -------------------------------------------- */

  cmdIntelCreate(worldId: WorldId, payload: any, user?: VaultCommandEnvelope["user"]) {
    return this.enqueueCommand(worldId, {
      type: "intel.create",
      version: 1,
      user,
      payload,
      return: { intel: true },
    });
  }

  cmdIntelUpdate(
    worldId: WorldId,
    payload: any,
    opts?: { ifMatch?: VaultCommandEnvelope["ifMatch"]; user?: VaultCommandEnvelope["user"] }
  ) {
    return this.enqueueCommand(worldId, {
      type: "intel.update",
      version: 1,
      user: opts?.user,
      ifMatch: opts?.ifMatch,
      payload,
      return: { intel: true },
    });
  }

  cmdIntelAssign(worldId: WorldId, actorId: string, payload: any, user?: VaultCommandEnvelope["user"]) {
    return this.enqueueCommand(worldId, {
      type: "intel.assign",
      version: 1,
      actorId,
      user,
      payload,
      return: { intel: true, actor: true },
    });
  }

  cmdIntelDelete(worldId: WorldId, payload: any, user?: VaultCommandEnvelope["user"]) {
    return this.enqueueCommand(worldId, {
      type: "intel.delete",
      version: 1,
      user,
      payload,
    });
  }

  /* -------------------------------------------- */
  /* VaultSync Journal Packs (quests/intel)        */
  /* -------------------------------------------- */

  journalIndexPath(worldId: WorldId, packId: string): string {
    // keep for compatibility if other code calls it
    return this.packIndexPathCandidates(worldId, packId)[0];
  }

  /** Path to a payload JSON for a journal entry in a pack. */
  journalPayloadPath(worldId: WorldId, packId: string, docId: string): string {
    // Folder name on disk matches Foundry export: safeId(packId)
    // "world.vaultsync-intel" -> "worldvaultsync-intel"
    const packFolder = safeId(packId);
    const file = `${safeId(docId)}.json`;

    return `${this.worldRoot(worldId)}/packs/${packFolder}/payloads/${file}`;
  }

  async readJournalPayload(worldId: WorldId, packId: string, docId: string): Promise<JournalPayload | null> {
    const rel = this.journalPayloadPath(worldId, packId, docId);
    return (await this.exists(rel)) ? this.readJson<JournalPayload>(rel) : null;
  }

  /**
   * List journal templates in a pack from the pack index.
   * This is the “fast list view” for your app.
   */
  async listJournalTemplates(worldId: WorldId, packId: string): Promise<{
    packId: string;
    label?: string;
    entries: Array<{
      id: string;
      uuid: string;
      name: string;
      vsType?: string;
      vsScope?: string;
      vsKey?: string;
      vsVersion?: number;
      category?: string;
      kind?: string;
      tags?: string[];
      media?: any;
    }>;
  } | null> {
    const idx = await this.readPackIndex(worldId, packId);
    if (!idx) return null;

    // Defensive: ensure it's a JournalEntry pack index (your writer sets this)
    if (idx.documentName && idx.documentName !== "JournalEntry") {
      return { packId, label: idx.label, entries: [] };
    }

    return {
      packId,
      label: idx.label,
      entries: Array.isArray(idx.entries) ? idx.entries : []
    };
  }

  /**
   * Convenience: read all payloads for a pack.
   * Use sparingly (can be many docs). Prefer listJournalTemplates + readJournalPayload.
   */
  async readAllJournalPayloads(worldId: WorldId, packId: string): Promise<JournalPayload[]> {
    const listing = await this.listJournalTemplates(worldId, packId);
    if (!listing) return [];

    const payloads: JournalPayload[] = [];
    for (const e of listing.entries) {
      const p = await this.readJournalPayload(worldId, packId, e.id);
      if (p) payloads.push(p);
    }
    return payloads;
  }

  /**
   * Read the deletion manifest produced by VaultSync export.
   * Your app can delete the listed files locally (Foundry can't).
   */
  async readDeleteManifest(worldId: WorldId): Promise<DeleteManifest | null> {
    return this.readJsonLatestOrSingle(this.metaDir(worldId), "delete");
  }

}



/* -------------------------------------------- */
/* Singleton Export                             */
/* -------------------------------------------- */

export const vault = new VaultStore(config.vaultRoot);
