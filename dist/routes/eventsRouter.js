// @ts-nocheck
import { Router } from "express";
import { makeRequireWorldMember } from "../middleware/authz.js";
import { eventsStore } from "../stores/eventsStore.js";
import { getFoundryCursor, upsertFoundryCursor } from "../services/db.js";
function asString(v) {
    const s = String(v ?? "").trim();
    return s ? s : null;
}
function asNumber(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}
function splitCsv(v) {
    const s = String(v ?? "").trim();
    if (!s)
        return [];
    return s.split(",").map(x => x.trim()).filter(Boolean);
}
function pickAuthUser(req) {
    return req.vaultUser ?? req.user ?? null;
}
function pickCharacterContext(req) {
    const characterId = asString(req.body?.data?.characterId);
    const characterName = asString(req.body?.actorName) ?? // allow top-level actorName
        asString(req.body?.data?.characterName) ?? // preferred: data.characterName
        null;
    return { characterId, characterName };
}
function pickEventTs(evt) {
    const msg = evt?.message ?? evt;
    const candidates = [
        msg?.timestamp,
        evt?.ts,
        evt?.timestamp,
        evt?.time,
        evt?.createdTs,
        evt?.created_at,
    ];
    for (const c of candidates) {
        const n = Number(c);
        if (Number.isFinite(n) && n > 0)
            return Math.trunc(n);
        const d = Date.parse(String(c ?? ""));
        if (Number.isFinite(d) && d > 0)
            return d;
    }
    return Date.now();
}
function pickEventKind(evt) {
    const msg = evt?.message ?? evt;
    if (msg?.isRoll)
        return "roll";
    if (Array.isArray(msg?.rolls) && msg.rolls.length)
        return "roll";
    const mt = msg?.flags?.dnd5e?.messageType ??
        msg?.context?.messageType ??
        null;
    if (String(mt ?? "").toLowerCase() === "roll")
        return "roll";
    return "chat";
}
function pickEventHtml(evt) {
    const msg = evt?.message ?? evt;
    // Foundry chat "content" is typically HTML or plaintext
    return asString(evt?.html ??
        msg?.html ??
        msg?.content ??
        evt?.content?.html ??
        evt?.messageHtml);
}
function pickEventSummary(evt) {
    const msg = evt?.message ?? evt;
    return asString(evt?.text ??
        evt?.content?.text ??
        msg?.content ??
        evt?.summary);
}
function pickActorId(evt) {
    const msg = evt?.message ?? evt;
    return asString(evt?.actorId ??
        msg?.speaker?.actor ??
        msg?.speaker?.actorId ??
        evt?.speaker?.actor ??
        evt?.speaker?.actorId);
}
function pickActorName(evt) {
    const msg = evt?.message ?? evt;
    return asString(evt?.actorName ??
        msg?.speaker?.alias ??
        msg?.speaker?.name ??
        evt?.speaker?.alias ??
        evt?.speaker?.name);
}
function pickTitle(evt) {
    const msg = evt?.message ?? evt;
    // Prefer something human-ish
    return asString(evt?.title ??
        msg?.flavor ??
        msg?.speaker?.alias ??
        msg?.speaker?.name ??
        msg?.author ?? // Foundry user id
        evt?.id);
}
function pickGroupId(evt) {
    const msg = evt?.message ?? evt;
    // Foundry chat message id is ideal grouping key
    return asString(msg?.id ?? evt?.id ?? evt?._id);
}
function inferFileId(evt) {
    return asString(evt?.file ?? evt?.filename ?? evt?._file ?? evt?._filename);
}
/**
 * Imports one shard (day+hour) into log_events
 * using vault.listChatEvents paging.
 */
async function importChatShard(args) {
    const { vault, worldId, day, hour } = args;
    const limitPerPage = Math.max(1, Math.min(500, args.limitPerPage ?? 200));
    const maxPages = Math.max(1, Math.min(10_000, args.maxPages ?? 2000));
    let afterTs = Number.isFinite(args.afterTs) ? Number(args.afterTs) : 0;
    let pages = 0;
    let imported = 0;
    let lastNextAfterTs = null;
    while (pages < maxPages) {
        pages++;
        const { events, nextAfterTs } = await vault.listChatEvents(worldId, { day, hour }, { afterTs, limit: limitPerPage });
        if (!Array.isArray(events) || events.length === 0) {
            lastNextAfterTs = nextAfterTs ?? afterTs;
            break;
        }
        for (let i = 0; i < events.length; i++) {
            const evt = events[i];
            const file = inferFileId(evt);
            // Best: stable id from filename
            if (file && typeof eventsStore.upsertFoundryChatFromVaultFile === "function") {
                eventsStore.upsertFoundryChatFromVaultFile({
                    worldId,
                    day,
                    hour,
                    file,
                    raw: evt
                });
                imported++;
                continue;
            }
            // Fallback: old path (still fixed via new pickers)
            const ts = pickEventTs(evt);
            const id = file
                ? eventsStore.makeFoundryEventId({ day, hour, file })
                : `foundry:${day}:${hour}:${ts}:${evt?.message?.id ?? evt?._id ?? evt?.id ?? i}`;
            eventsStore.upsertEvent({
                id,
                worldId,
                ts,
                source: "foundry",
                kind: pickEventKind(evt),
                actorId: pickActorId(evt),
                actorName: pickActorName(evt),
                title: pickTitle(evt),
                summary: pickEventSummary(evt),
                html: pickEventHtml(evt),
                groupId: pickGroupId(evt),
                data: evt
            });
            imported++;
        }
        // advance pagination
        const n = Number(nextAfterTs);
        if (!Number.isFinite(n) || n <= afterTs) {
            // safety: prevent infinite loop if vault returns a bad cursor
            lastNextAfterTs = afterTs;
            break;
        }
        afterTs = n;
        lastNextAfterTs = n;
    }
    return { imported, nextAfterTs: lastNextAfterTs ?? afterTs, pages };
}
export function makeEventsRouter(deps) {
    const router = Router();
    const requireWorldMember = makeRequireWorldMember(deps.authStore);
    const { vault } = deps;
    /**
     * Unified feed:
     * GET /worlds/:worldId/events?limit=100&beforeTs=...&afterTs=...&kinds=chat,roll&source=foundry|vaulthero&actorId=...&groupId=...
     *
     * Returns ONLY from SQLite (log_events).
     * Foundry chat appears here after you call the import endpoint below.
     */
    router.get("/:worldId/events", requireWorldMember, async (req, res, next) => {
        try {
            const { worldId } = req.params;
            const limit = asNumber(req.query.limit, 100);
            const beforeTs = req.query.beforeTs != null ? asNumber(req.query.beforeTs, Number.MAX_SAFE_INTEGER) : undefined;
            const afterTs = req.query.afterTs != null ? asNumber(req.query.afterTs, 0) : undefined;
            const kinds = splitCsv(req.query.kinds);
            const source = req.query.source != null ? String(req.query.source) : undefined;
            const actorId = req.query.actorId != null ? String(req.query.actorId) : undefined;
            const groupId = req.query.groupId != null ? String(req.query.groupId) : undefined;
            const { events } = eventsStore.listEvents({
                worldId,
                limit,
                beforeTs,
                afterTs,
                kinds: kinds.length ? kinds : undefined,
                source,
                actorId,
                groupId
            });
            res.json({ ok: true, count: events.length, events });
        }
        catch (err) {
            next(err);
        }
    });
    /**
     * Create a Vaulthero/local event:
     * POST /worlds/:worldId/events
     * body: { kind, ts?, actorId?, actorName?, title?, summary?, html?, groupId?, data? }
     */
    router.post("/:worldId/events", requireWorldMember, async (req, res, next) => {
        try {
            const { worldId } = req.params;
            const kind = String(req.body?.kind ?? "other").trim();
            const ts = req.body?.ts != null ? asNumber(req.body.ts, Date.now()) : Date.now();
            const authUser = pickAuthUser(req);
            const { characterId, characterName } = pickCharacterContext(req);
            const inCharacter = !!characterId;
            const actorId = asString(req.body?.actorId) ??
                (inCharacter ? characterId : asString(authUser?.id));
            const actorName = inCharacter
                ? characterName // ✅ character name wins
                : (asString(req.body?.actorName) ??
                    asString(authUser?.display_name) ??
                    asString(authUser?.name) ??
                    asString(authUser?.email));
            const out = eventsStore.createLocalEvent({
                worldId,
                kind,
                ts,
                actorId: actorId ?? null,
                actorName: actorName ?? null,
                title: req.body?.title ?? null,
                summary: req.body?.summary ?? null,
                html: req.body?.html ?? null,
                groupId: req.body?.groupId ?? null,
                data: {
                    ...(req.body?.data ?? {}),
                    _meta: {
                        ...(req.body?.data?._meta ?? {}),
                        source: "vaulthero",
                        vaultUserId: authUser?.id ?? null,
                        vaultDisplayName: authUser?.display_name ?? authUser?.name ?? null,
                        vaultUserEmail: authUser?.email ?? null
                    }
                }
            });
            if (!out.ok)
                return res.status(400).json(out);
            res.json({ ok: true, id: out.id });
        }
        catch (err) {
            next(err);
        }
    });
    /**
     * Upsert (update or create by id) — useful if you want editing later.
     * PUT /worlds/:worldId/events/:id
     */
    router.put("/:worldId/events/:id", requireWorldMember, async (req, res, next) => {
        try {
            const { worldId, id } = req.params;
            const ts = req.body?.ts != null ? asNumber(req.body.ts, Date.now()) : Date.now();
            const source = String(req.body?.source ?? "vaulthero");
            const kind = String(req.body?.kind ?? "other");
            const authUser = pickAuthUser(req);
            const { characterId, characterName } = pickCharacterContext(req);
            const inCharacter = !!characterId;
            const actorId = asString(req.body?.actorId) ??
                (inCharacter ? characterId : asString(authUser?.id));
            const actorName = inCharacter
                ? characterName // ✅ character name wins
                : (asString(req.body?.actorName) ??
                    asString(authUser?.display_name) ??
                    asString(authUser?.name) ??
                    asString(authUser?.email));
            const out = eventsStore.upsertEvent({
                id,
                worldId,
                ts,
                source,
                kind,
                actorId: actorId ?? null,
                actorName: actorName ?? null,
                title: req.body?.title ?? null,
                summary: req.body?.summary ?? null,
                html: req.body?.html ?? null,
                groupId: req.body?.groupId ?? null,
                data: {
                    ...(req.body?.data ?? {}),
                    _meta: {
                        ...(req.body?.data?._meta ?? {}),
                        source,
                        vaultUserId: authUser?.id ?? null,
                        vaultDisplayName: authUser?.display_name ?? authUser?.name ?? null,
                        vaultUserEmail: authUser?.email ?? null
                    }
                }
            });
            if (!out.ok)
                return res.status(400).json(out);
            res.json({ ok: true, id: out.id });
        }
        catch (err) {
            next(err);
        }
    });
    /**
     * Delete one event
     * DELETE /worlds/:worldId/events/:id
     */
    router.delete("/:worldId/events/:id", requireWorldMember, async (req, res, next) => {
        try {
            const { id } = req.params;
            const out = eventsStore.deleteById(id);
            res.json({ ok: true, deleted: out.deleted });
        }
        catch (err) {
            next(err);
        }
    });
    /**
     * Import Foundry chat into SQLite so the unified feed can show it.
     *
     * POST /worlds/:worldId/events/import/foundry-chat
     * body options:
     *  - day?: "YYYY-MM-DD"
     *  - hour?: "HH" (or "0".."23" depending how your vault stores it)
     *  - daysBack?: number (default 2) imports the most recent N chat days
     *  - limitPerPage?: number (default 200)
     *  - afterTs?: number (default 0) start cursor within shard
     *
     * Behavior:
     *  - if day+hour => import that shard only
     *  - if day only  => import all shard hours for that day
     *  - else         => import latest daysBack days (all hours each)
     */
    /**
     * Full (backfill) import of Foundry chat from the VaultSync flat exports directory.
     *
     * Reads ALL files from vaultsync/exports/chat/ (subject to limit) regardless
     * of daysBack or day/hour filtering — since VaultSync writes to a flat dir, the
     * old day/hour shard structure doesn't apply.
     *
     * POST /worlds/:worldId/events/import/foundry-chat
     * body: { limitPerPage?, afterTs? }
     */
    router.post("/:worldId/events/import/foundry-chat", requireWorldMember, async (req, res, next) => {
        try {
            const { worldId } = req.params;
            const limitPerPage = Math.max(1, Math.min(500, asNumber(req.body?.limitPerPage, 200)));
            // afterTs=0 means "import everything"; callers can pass a cursor to resume
            const afterTs = req.body?.afterTs != null ? asNumber(req.body.afterTs, 0) : 0;
            const CURSOR_DAY = "exports";
            const CURSOR_HOUR = "chat";
            const { events: exportFiles, nextAfterTs } = await vault.listChatExportsFlat(worldId, {
                afterTs,
                limit: limitPerPage,
            });
            let totalImported = 0;
            for (const { file, raw } of exportFiles) {
                eventsStore.upsertFoundryChatFromVaultFile({
                    worldId,
                    day: CURSOR_DAY,
                    hour: CURSOR_HOUR,
                    file,
                    raw,
                });
                totalImported++;
            }
            // Advance the cursor so the tick doesn't re-ingest these files
            if (nextAfterTs > afterTs) {
                upsertFoundryCursor(worldId, CURSOR_DAY, CURSOR_HOUR, nextAfterTs);
            }
            res.json({
                ok: true,
                worldId,
                totalImported,
                shards: [{ day: CURSOR_DAY, hour: CURSOR_HOUR, imported: totalImported, nextAfterTs }],
            });
        }
        catch (err) {
            next(err);
        }
    });
    /**
     * Tick: import new Foundry chat from the VaultSync flat exports directory.
     *
     * VaultSync writes ExportRecord files to:
     *   vaultsync/exports/chat/chat.{msgId}.{epochMs}.{nonce}.json
     *
     * We use a single cursor per world (stored as day="exports", hour="chat" in
     * the foundry_chat_cursors table) to track the highest timestamp ingested so
     * far and only read files newer than that.
     */
    router.post("/:worldId/events/import/foundry-chat/tick", requireWorldMember, async (req, res, next) => {
        try {
            const { worldId } = req.params;
            const limitPerPage = Math.max(1, Math.min(200, asNumber(req.body?.limitPerPage, 100)));
            // Cursor key for the flat exports directory (sentinel values, not real day/hour)
            const CURSOR_DAY = "exports";
            const CURSOR_HOUR = "chat";
            const cursor = getFoundryCursor(worldId, CURSOR_DAY, CURSOR_HOUR);
            const afterTs = cursor?.afterTs ?? 0;
            // Read files from vaultsync/exports/chat/ newer than our cursor
            const { events: exportFiles, nextAfterTs } = await vault.listChatExportsFlat(worldId, {
                afterTs,
                limit: limitPerPage,
            });
            let imported = 0;
            for (const { file, raw } of exportFiles) {
                // upsertFoundryChatFromVaultFile now handles ExportRecord { foundry: {...} }
                // as well as the legacy ChatEventEnvelope { message: {...} } format
                eventsStore.upsertFoundryChatFromVaultFile({
                    worldId,
                    day: CURSOR_DAY,
                    hour: CURSOR_HOUR,
                    file,
                    raw,
                });
                imported++;
            }
            if (nextAfterTs > afterTs) {
                upsertFoundryCursor(worldId, CURSOR_DAY, CURSOR_HOUR, nextAfterTs);
            }
            res.json({
                ok: true,
                worldId,
                totalImported: imported,
                shards: [{ day: CURSOR_DAY, hour: CURSOR_HOUR, imported, nextAfterTs }],
            });
        }
        catch (err) {
            next(err);
        }
    });
    return router;
}
//# sourceMappingURL=eventsRouter.js.map