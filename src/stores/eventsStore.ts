// /src/services/eventsStore.ts
import { db } from "../services/db.js";
import { v4 as uuid } from "uuid";

export type EventSource = "foundry" | "vaulthero";
export type EventKind =
  | "chat"
  | "roll"
  | "attack"
  | "damage"
  | "hp"
  | "system"
  | "note"
  | "other";

export type LogEventRow = {
  id: string;
  world_id: string;
  ts: number;
  source: EventSource | string;
  kind: EventKind | string;

  actor_id: string | null;
  actor_name: string | null;

  title: string | null;
  summary: string | null;
  html: string | null;
  group_id: string | null;

  data_json: string | null;
};

export type LogEvent = {
  id: string;
  worldId: string;
  ts: number;
  source: EventSource | string;
  kind: EventKind | string;

  actorId?: string | null;
  actorName?: string | null;

  title?: string | null;
  summary?: string | null;
  html?: string | null;
  groupId?: string | null;

  data?: any; // parsed JSON
};

function toInt(n: any, fallback: number) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.trunc(x) : fallback;
}

function safeJsonStringify(v: any): string | null {
  if (v === undefined) return null;
  try {
    return JSON.stringify(v);
  } catch {
    return JSON.stringify({ _error: "unserializable", type: typeof v });
  }
}

function rowToEvent(r: LogEventRow): LogEvent {
  return {
    id: r.id,
    worldId: r.world_id,
    ts: r.ts,
    source: r.source,
    kind: r.kind,
    actorId: r.actor_id,
    actorName: r.actor_name,
    title: r.title,
    summary: r.summary,
    html: r.html,
    groupId: r.group_id,
    data: r.data_json ? (() => { try { return JSON.parse(r.data_json); } catch { return r.data_json; } })() : null
  };
}

type FoundryChatEnvelope = {
  op?: string; // "create" | "update" | "delete"
  ts?: number;
  id?: string; // often same as message.id
  message?: any;
};

function stripHtmlToText(html: string) {
  // Keep it simple (server-side). If you want better, use a sanitizer library.
  return String(html ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function deriveFoundryKind(msg: any): EventKind | string {
  const t = String(msg?.type ?? "").toLowerCase();
  if (t === "roll") return "roll";
  if (t === "base") return "chat";

  // You can extend this later for dnd5e cards:
  // - if msg.content contains "Damage" etc.
  return "chat";
}

export class EventsStore {

  /**
   * Maps a Foundry chat message envelope (from vaultsync/vaultapi shard files)
   * into your normalized log_events format and upserts it.
   *
   * NOTE: id stability comes from filename + day/hour. This prevents duplicates.
   */
  upsertFoundryChatFromVaultFile(args: {
    worldId: string;
    day: string;
    hour: string;
    file: string;
    raw: FoundryChatEnvelope | any;
  }) {
    const worldId = String(args.worldId ?? "").trim();
    const day = String(args.day ?? "").trim();
    const hour = String(args.hour ?? "").trim();
    const file = String(args.file ?? "").trim();
    if (!worldId) return { ok: false as const, error: "Missing worldId" };
    if (!day || !hour || !file) return { ok: false as const, error: "Missing shard identity (day/hour/file)" };

    const raw = args.raw ?? {};
    // Support both payload shapes:
    //   ExportRecord       { type: "export", foundry: { ...ChatMessage... } }  — written by VaultSync exportChatMessage()
    //   ChatEventEnvelope  { op: "create",   message: { ...ChatMessage... } }  — legacy shard format
    const msg = raw?.foundry ?? raw?.message ?? {};
    function normalizeEpochMs(n: number) {
    // if it looks like seconds, convert to ms
    if (n > 0 && n < 10_000_000_000) return n * 1000;
    return n;
    }
    const tsRaw =
    toInt(msg?.timestamp, 0) ||
    toInt(raw?.ts, 0) ||
    Date.now();

    const ts = normalizeEpochMs(tsRaw);

    const kind = deriveFoundryKind(msg);

    const actorId = msg?.speaker?.actor != null ? String(msg.speaker.actor) : null;

    // We usually don't have actor_name in the message payload; optionally resolve later in UI.
    const actorName =
        msg?.speaker?.alias != null ? String(msg.speaker.alias) :
        msg?.speaker?.name != null ? String(msg.speaker.name) :
        null;

    const html = msg?.content != null ? String(msg.content) : null;

    // Use plain text for summary if html exists
    const summary =
      html ? stripHtmlToText(html) :
      msg?.content != null ? String(msg.content) :
      null;

    const groupId =
      msg?.id != null ? String(msg.id) :
      raw?.id != null ? String(raw.id) :
      null;

    const id = this.makeFoundryEventId({ day, hour, file });

    return this.upsertEvent({
      id,
      worldId,
      ts,
      source: "foundry",
      kind,
      actorId,
      actorName,
      title: null,
      summary,
      html,
      groupId,
      data: raw
    });
  }

  /** Upsert is key for Foundry ingest: same id should update safely. */
  upsertEvent(input: {
    id: string;
    worldId: string;
    ts: number;

    source: EventSource | string;
    kind: EventKind | string;

    actorId?: string | null;
    actorName?: string | null;

    title?: string | null;
    summary?: string | null;
    html?: string | null;
    groupId?: string | null;

    data?: any;
  }) {
    const id = String(input.id ?? "").trim();
    const worldId = String(input.worldId ?? "").trim();
    if (!id) return { ok: false as const, error: "Missing id" };
    if (!worldId) return { ok: false as const, error: "Missing worldId" };

    const ts = toInt(input.ts, Date.now());
    const source = String(input.source ?? "vaulthero");
    const kind = String(input.kind ?? "other");

    const actorId = input.actorId != null ? String(input.actorId) : null;
    const actorName = input.actorName != null ? String(input.actorName) : null;

    const title = input.title != null ? String(input.title) : null;
    const summary = input.summary != null ? String(input.summary) : null;
    const html = input.html != null ? String(input.html) : null;
    const groupId = input.groupId != null ? String(input.groupId) : null;

    const dataJson = safeJsonStringify(input.data);

    db.prepare(`
      INSERT INTO log_events (
        id, world_id, ts, source, kind,
        actor_id, actor_name,
        title, summary, html,
        group_id, data_json
      )
      VALUES (
        @id, @worldId, @ts, @source, @kind,
        @actorId, @actorName,
        @title, @summary, @html,
        @groupId, @dataJson
      )
      ON CONFLICT(id) DO UPDATE SET
        world_id  = excluded.world_id,
        ts        = excluded.ts,
        source    = excluded.source,
        kind      = excluded.kind,
        actor_id  = excluded.actor_id,
        actor_name= excluded.actor_name,
        title     = excluded.title,
        summary   = excluded.summary,
        html      = excluded.html,
        group_id  = excluded.group_id,
        data_json = excluded.data_json
    `).run({
      id,
      worldId,
      ts,
      source,
      kind,
      actorId,
      actorName,
      title,
      summary,
      html,
      groupId,
      dataJson,
    });

    return { ok: true as const, id };
  }

  /**
   * Convenience for local frontend-driven events:
   * Generates a stable-ish id so duplicates are unlikely.
   */
  createLocalEvent(input: {
    worldId: string;
    ts?: number;

    kind: EventKind | string;

    actorId?: string | null;
    actorName?: string | null;

    title?: string | null;
    summary?: string | null;
    html?: string | null;
    groupId?: string | null;

    data?: any;
  }) {
    const worldId = String(input.worldId ?? "").trim();
    if (!worldId) return { ok: false as const, error: "Missing worldId" };

    const ts = toInt(input.ts, Date.now());
    const id = `vh:${uuid()}`;

    return this.upsertEvent({
      id,
      worldId,
      ts,
      source: "vaulthero",
      kind: input.kind,
      actorId: input.actorId ?? null,
      actorName: input.actorName ?? null,
      title: input.title ?? null,
      summary: input.summary ?? null,
      html: input.html ?? null,
      groupId: input.groupId ?? null,
      data: input.data,
    });
  }

  getById(id: string): LogEvent | null {
    const row = db
      .prepare(`SELECT * FROM log_events WHERE id=?`)
      .get(id) as LogEventRow | undefined;

    return row ? rowToEvent(row) : null;
  }

  /**
   * Feed query (newest-first).
   * - Use beforeTs for infinite scroll backwards
   * - Use afterTs for polling forward
   */
  listEvents(args: {
    worldId: string;
    limit?: number;
    beforeTs?: number; // return events with ts < beforeTs
    afterTs?: number;  // return events with ts > afterTs

    kinds?: string[];  // filter kind IN (...)
    source?: string;   // filter source
    actorId?: string;  // filter actor_id
    groupId?: string;  // filter group_id
  }): { events: LogEvent[] } {
    const worldId = String(args.worldId ?? "").trim();
    if (!worldId) return { events: [] };

    const limit = Math.max(1, Math.min(500, toInt(args.limit, 100)));

    const where: string[] = [`world_id = @worldId`];
    const params: any = { worldId, limit };

    if (args.beforeTs != null) {
      where.push(`ts < @beforeTs`);
      params.beforeTs = toInt(args.beforeTs, Number.MAX_SAFE_INTEGER);
    }
    if (args.afterTs != null) {
      where.push(`ts > @afterTs`);
      params.afterTs = toInt(args.afterTs, 0);
    }
    if (args.source) {
      where.push(`source = @source`);
      params.source = String(args.source);
    }
    if (args.actorId) {
      where.push(`actor_id = @actorId`);
      params.actorId = String(args.actorId);
    }
    if (args.groupId) {
      where.push(`group_id = @groupId`);
      params.groupId = String(args.groupId);
    }

    // kinds IN (...)
    let kindClause = "";
    const kinds = (args.kinds ?? []).map(k => String(k).trim()).filter(Boolean);
    if (kinds.length) {
      const placeholders = kinds.map((_, i) => `@k${i}`).join(", ");
      kindClause = ` AND kind IN (${placeholders})`;
      kinds.forEach((k, i) => (params[`k${i}`] = k));
    }

    const sql = `
      SELECT *
      FROM log_events
      WHERE ${where.join(" AND ")}${kindClause}
      ORDER BY ts DESC
      LIMIT @limit
    `;

    const rows = db.prepare(sql).all(params) as LogEventRow[];
    return { events: rows.map(rowToEvent) };
  }

  deleteById(id: string) {
    const info = db.prepare(`DELETE FROM log_events WHERE id=?`).run(id);
    return { ok: true as const, deleted: info.changes ?? 0 };
  }

  deleteWorldEvents(worldId: string) {
    const wid = String(worldId ?? "").trim();
    if (!wid) return { ok: false as const, error: "Missing worldId" };

    const info = db.prepare(`DELETE FROM log_events WHERE world_id=?`).run(wid);
    return { ok: true as const, deleted: info.changes ?? 0 };
  }

  pruneOlderThan(args: { worldId: string; tsCutoff: number }) {
    const wid = String(args.worldId ?? "").trim();
    if (!wid) return { ok: false as const, error: "Missing worldId" };

    const cutoff = toInt(args.tsCutoff, 0);
    const info = db
      .prepare(`DELETE FROM log_events WHERE world_id=? AND ts < ?`)
      .run(wid, cutoff);

    return { ok: true as const, deleted: info.changes ?? 0 };
  }

  /**
   * Helper: creates a stable id for Foundry-shard events.
   * Use this when importing from your vault shard filenames.
   */
  makeFoundryEventId(args: { day: string; hour: string; file: string }) {
    const day = String(args.day ?? "").trim();
    const hour = String(args.hour ?? "").trim();
    const file = String(args.file ?? "").trim();
    return `foundry:${day}:${hour}:${file}`;
  }
}

export const eventsStore = new EventsStore();