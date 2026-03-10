// @ts-nocheck
import path from "node:path";
import fs from "node:fs/promises";
import { config } from "../config.js";
import { createLogger } from "./logger.js";
const logger = createLogger(process.env.LOG_LEVEL ?? "info");
export function safeId(id) {
    // Must match vault-sync safeId() exactly (filenames must line up)
    return String(id ?? "unknown").replace(/[^a-zA-Z0-9_-]/g, "");
}
export class VaultStore {
    dataRoot;
    /**
     * @param dataRoot Absolute path to Foundry UserData root (or wherever `vault/` lives).
     * Example: /path/to/FoundryVTT/Data
     */
    constructor(dataRoot) {
        this.dataRoot = dataRoot;
    }
    /* -------------------------------------------- */
    /* Core path helpers (safe)                     */
    /* -------------------------------------------- */
    /** Join and ensure the result stays within dataRoot (prevents traversal). */
    abs(rel) {
        const cleaned = String(rel ?? "").replace(/^\/+/, ""); // force relative
        const out = path.resolve(this.dataRoot, cleaned);
        const root = path.resolve(this.dataRoot);
        if (!out.startsWith(root + path.sep) && out !== root) {
            throw new Error(`VaultStore: path escapes root: ${rel}`);
        }
        return out;
    }
    worldRoot(worldId) {
        return `worlds/${worldId}`;
    }
    /** App-owned root (VaultSync writes here) */
    vaultRoot(worldId) {
        return `${this.worldRoot(worldId)}/vaultsync`;
    }
    /** App-owned meta */
    metaDir(worldId) {
        return `${this.vaultRoot(worldId)}/meta`;
    }
    /** App-owned requests */
    requestsDir(worldId) {
        return `${this.vaultRoot(worldId)}/requests`;
    }
    /* -------------------------------------------- */
    /* Generic fs helpers                           */
    /* -------------------------------------------- */
    async listFilesSafe(rel) {
        try {
            return await this.listFiles(rel);
        }
        catch {
            return [];
        }
    }
    parseVersionedTs(name, base) {
        // base.ts.suffix.json
        if (!name.startsWith(base + "."))
            return null;
        if (!name.endsWith(".json"))
            return null;
        const parts = name.split(".");
        if (parts.length < 4)
            return null;
        const ts = Number(parts[parts.length - 3]);
        return Number.isFinite(ts) ? ts : null;
    }
    async readLatestVersionedJsonInDir(dirRel, baseName) {
        const files = await this.listFilesSafe(dirRel);
        let best = null;
        for (const f of files) {
            const ts = this.parseVersionedTs(f, baseName);
            if (ts == null)
                continue;
            if (!best || ts > best.ts)
                best = { f, ts };
        }
        if (!best)
            return null;
        return this.readJson(`${dirRel}/${best.f}`);
    }
    /**
     * Back-compat: try versioned latest first, then fall back to single file.
     */
    async readJsonLatestOrSingle(dirRel, baseName) {
        const v = await this.readLatestVersionedJsonInDir(dirRel, baseName);
        if (v !== null)
            return v;
        const single = `${dirRel}/${baseName}.json`;
        return (await this.exists(single)) ? this.readJson(single) : null;
    }
    async exists(rel) {
        try {
            await fs.access(this.abs(rel));
            return true;
        }
        catch {
            return false;
        }
    }
    async readText(rel) {
        return fs.readFile(this.abs(rel), "utf-8");
    }
    async readJson(rel) {
        const txt = await this.readText(rel);
        return JSON.parse(txt);
    }
    async writeText(rel, text) {
        const file = this.abs(rel);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, text, "utf-8");
    }
    async writeJson(rel, data) {
        await this.writeText(rel, JSON.stringify(data, null, 2));
    }
    /** Compatibility: newline-delimited JSON append (server-side filesystem append). */
    async appendJsonl(rel, obj) {
        const file = this.abs(rel);
        await fs.mkdir(path.dirname(file), { recursive: true });
        const line = JSON.stringify(obj) + "\n";
        await fs.appendFile(file, line, "utf-8");
    }
    async deleteFile(rel) {
        try {
            await fs.unlink(this.abs(rel));
        }
        catch {
            // ignore missing
        }
    }
    async listDirs(rel) {
        const entries = await fs.readdir(this.abs(rel), { withFileTypes: true });
        return entries.filter(e => e.isDirectory()).map(e => e.name);
    }
    async listFiles(rel) {
        const entries = await fs.readdir(this.abs(rel), { withFileTypes: true });
        return entries.filter(e => e.isFile()).map(e => e.name);
    }
    async cleanupDocRequestFromAck(worldId, ack) {
        // Prefer the explicit path written by vault-sync
        const requestPath = typeof ack?.requestPath === "string" ? ack.requestPath : null;
        const requestFile = typeof ack?.requestFile === "string" ? ack.requestFile : null;
        // If vault-sync wrote an absolute-ish vault path like "vault/worlds/..." strip leading "vault/"
        // because VaultStore.abs() is rooted at the Foundry data root.
        const normalizeRel = (p) => String(p).replace(/^\/+/, "").replace(/^vault\//, "");
        // Determine request rel path
        let rel = null;
        if (requestPath)
            rel = normalizeRel(requestPath);
        else if (requestFile)
            rel = `${this.docRequestDir(worldId)}/${requestFile}`;
        if (!rel)
            return;
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
    async ensureWorldScaffold(worldId) {
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
    async listWorldIds() {
        const base = "worlds";
        if (!(await this.exists(base)))
            return [];
        return this.listDirs(base);
    }
    /** Compatibility alias (older routes often call listWorlds). */
    async listWorlds() {
        return this.listWorldIds();
    }
    vaultSyncRoot(worldId) {
        return `worlds/${worldId}/vaultsync`;
    }
    async readWorldMeta(worldId) {
        return this.readJsonLatestOrSingle(this.metaDir(worldId), "world");
    }
    async readUsersMeta(worldId) {
        return this.readJsonLatestOrSingle(this.metaDir(worldId), "users");
    }
    async readVaultMeta(worldId) {
        return this.readJsonLatestOrSingle(this.metaDir(worldId), "vault");
    }
    async readStatusMeta(worldId) {
        return this.readJsonLatestOrSingle(this.metaDir(worldId), "status");
    }
    async readPolicyMeta(worldId) {
        return this.readJsonLatestOrSingle(this.metaDir(worldId), "policy");
    }
    async getWorldOnlineStatus(worldId) {
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
    actorPath(worldId, actorId) {
        return `${this.worldRoot(worldId)}/data/actors/${actorId}.json`;
    }
    async readActor(worldId, actorId) {
        const rel = this.actorPath(worldId, actorId);
        return (await this.exists(rel)) ? this.readJson(rel) : null;
    }
    async readActorsManifest(worldId) {
        const rel = `${this.worldRoot(worldId)}/manifests/actors.json`;
        return (await this.exists(rel)) ? this.readJson(rel) : null;
    }
    /** Handy for routes: list actor file ids without reading manifest. */
    async listActorIds(worldId) {
        const rel = `${this.worldRoot(worldId)}/actors`;
        if (!(await this.exists(rel)))
            return [];
        const files = await this.listFiles(rel);
        return files
            .filter(f => f.endsWith(".json"))
            .map(f => f.replace(/\.json$/i, ""))
            .sort((a, b) => a.localeCompare(b));
    }
    async readActorTombstone(worldId, actorId) {
        const rel = `${this.worldRoot(worldId)}/actors/tombstones/${actorId}.json`;
        return (await this.exists(rel)) ? this.readJson(rel) : null;
    }
    /* -------------------------------------------- */
    /* Chat shards + events                         */
    /* -------------------------------------------- */
    chatShardDir(worldId, shard) {
        return `${this.vaultRoot(worldId)}/chat/events/${shard.day}/${shard.hour}`;
    }
    chatShardManifestPath(worldId, shard) {
        return `${this.vaultRoot(worldId)}/chat/manifests/${shard.day}/${shard.hour}.json`;
    }
    /** List all days that have chat manifests. */
    async listChatDays(worldId) {
        const rel = `${this.worldRoot(worldId)}/chat/manifests`;
        if (!(await this.exists(rel)))
            return [];
        return (await this.listDirs(rel)).sort((a, b) => a.localeCompare(b));
    }
    async listChatShardHours(worldId, day) {
        const rel = `${this.worldRoot(worldId)}/chat/manifests/${day}`;
        if (!(await this.exists(rel)))
            return [];
        const files = await this.listFiles(rel);
        return files
            .filter(f => f.endsWith(".json"))
            .map(f => f.replace(/\.json$/, ""))
            .sort((a, b) => a.localeCompare(b));
    }
    async readChatShardManifest(worldId, shard) {
        const rel = this.chatShardManifestPath(worldId, shard);
        return (await this.exists(rel)) ? this.readJson(rel) : null;
    }
    async listChatEvents(worldId, shard, opts = {}) {
        const afterTs = Number(opts.afterTs ?? 0);
        const limit = Math.max(1, Math.min(Number(opts.limit ?? 200), 2000));
        const dir = this.chatShardDir(worldId, shard);
        if (!(await this.exists(dir)))
            return { events: [], nextAfterTs: afterTs };
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
        const events = await Promise.all(files.map(x => this.readJson(`${dir}/${x.f}`)));
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
    async listChatExportsFlat(worldId, opts = {}) {
        const afterTs = Number(opts.afterTs ?? 0);
        const limit = Math.max(1, Math.min(Number(opts.limit ?? 200), 2000));
        const dir = `${this.vaultRoot(worldId)}/exports/chat`;
        if (!(await this.exists(dir)))
            return { events: [], nextAfterTs: afterTs };
        let allFiles;
        try {
            allFiles = await this.listFiles(dir);
        }
        catch {
            return { events: [], nextAfterTs: afterTs };
        }
        // Parse filenames: chat.{msgId}.{epochMs}.{nonce}.json
        // epochMs is at parts[parts.length - 2] after stripping .json
        const parsed = [];
        for (const f of allFiles) {
            if (!f.endsWith(".json"))
                continue;
            const base = f.slice(0, -5); // strip .json
            const parts = base.split(".");
            if (parts.length < 4)
                continue;
            const ts = Number(parts[parts.length - 2]);
            if (!Number.isFinite(ts) || ts <= 0)
                continue;
            if (ts > afterTs)
                parsed.push({ f, ts });
        }
        const sorted = parsed
            .sort((a, b) => a.ts - b.ts)
            .slice(0, limit);
        const events = [];
        for (const x of sorted) {
            try {
                const raw = await this.readJson(`${dir}/${x.f}`);
                events.push({ file: x.f, ts: x.ts, raw });
            }
            catch {
                // skip unreadable files
            }
        }
        const nextAfterTs = events.length ? events[events.length - 1].ts : afterTs;
        return { events, nextAfterTs };
    }
    /* -------------------------------------------- */
    /* Documents                        */
    /* -------------------------------------------- */
    async readPacksManifest(worldId) {
        const rel = `${this.worldRoot(worldId)}/manifests/packs.json`;
        return (await this.exists(rel)) ? this.readJson(rel) : null;
    }
    packIndexPath(worldId, packId) {
        return `${this.worldRoot(worldId)}/packs/${safeId(packId)}.index.json`;
    }
    packIndexPathCandidates(worldId, packId) {
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
    async readPackIndex(worldId, packId) {
        for (const rel of this.packIndexPathCandidates(worldId, packId)) {
            if (await this.exists(rel))
                return this.readJson(rel);
        }
        logger.warn("readPackIndex: not found", { worldId, packId, tried: this.packIndexPathCandidates(worldId, packId) });
        return null;
    }
    async readActorDocRefsManifest(worldId) {
        const rel = `${this.worldRoot(worldId)}/manifests/actor-doc-refs.json`;
        return (await this.exists(rel)) ? this.readJson(rel) : null;
    }
    docPath(worldId, uuid) {
        return `${this.worldRoot(worldId)}/docs/${safeId(uuid)}.json`;
    }
    async readDoc(worldId, uuid) {
        const rel = this.docPath(worldId, uuid);
        return (await this.exists(rel)) ? this.readJson(rel) : null;
    }
    docRequestDir(worldId) {
        return `${this.requestsDir(worldId)}/export-docs`;
    }
    docDoneDir(worldId) {
        return `${this.requestsDir(worldId)}/export-docs-done`;
    }
    async requestDocs(worldId, uuids) {
        const requestId = `export-docs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const rel = `${this.docRequestDir(worldId)}/${requestId}.json`;
        await this.writeJson(rel, {
            requestId,
            uuids,
            ts: Date.now()
        });
        logger.info("docs.requestDocs", { worldId, requestId, requestPath: rel, exists: await this.exists(rel), });
        return { requestId };
    }
    async readDocRequestAck(worldId, requestId) {
        const rel = `${this.docDoneDir(worldId)}/${safeId(requestId)}.json`;
        const exists = await this.exists(rel);
        logger.info("docs.readDocRequestAck", { worldId, requestId, ackPath: rel, exists });
        if (!exists)
            return null;
        const ack = await this.readJson(rel);
        // Opportunistic cleanup (best-effort, ignore failures)
        try {
            await this.cleanupDocRequestFromAck(worldId, ack);
        }
        catch (e) {
            logger.warn("docs.cleanup failed", { worldId, requestId, err: e });
        }
        return ack;
    }
    /* -------------------------------------------- */
    /* Commands (two-way actions)                   */
    /* -------------------------------------------- */
    commandRequestDir(worldId) {
        return `${this.requestsDir(worldId)}/commands`;
    }
    commandDoneDir(worldId) {
        return `${this.requestsDir(worldId)}/commands-done`;
    }
    async enqueueCommand(worldId, cmd) {
        const requestId = String(cmd?.requestId ?? "").trim() ||
            `cmd-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const envelope = {
            schema: "vaultsync.command.v1",
            requestId,
            ts: Date.now(),
            worldId,
            type: cmd.type,
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
    async readCommandAck(worldId, requestId) {
        const rel = `${this.commandDoneDir(worldId)}/${safeId(requestId)}.json`;
        if (!(await this.exists(rel)))
            return null;
        const ack = await this.readJson(rel);
        try {
            await this.cleanupCommandRequestFromAck(worldId, ack);
        }
        catch (e) {
            logger.warn("commands.cleanup failed", { worldId, requestId, err: e });
        }
        return ack;
    }
    async cleanupCommandRequestFromAck(worldId, ack) {
        const requestPath = typeof ack?.requestPath === "string" ? ack.requestPath : null;
        const requestFile = typeof ack?.requestFile === "string" ? ack.requestFile : null;
        const normalizeRel = (p) => String(p).replace(/^\/+/, "").replace(/^vault\//, "");
        let rel = null;
        if (requestPath)
            rel = normalizeRel(requestPath);
        else if (requestFile)
            rel = `${this.commandRequestDir(worldId)}/${requestFile}`;
        if (!rel)
            return;
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
    cmdActorCreate(worldId, payload, user) {
        return this.enqueueCommand(worldId, {
            type: "actor.create",
            version: 1,
            user,
            payload,
            return: { actor: true, actorId: true },
        });
    }
    cmdActorUpdate(worldId, actorId, payload, opts) {
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
    cmdActorDelete(worldId, actorId, user) {
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
    cmdQuestCreate(worldId, payload, user) {
        return this.enqueueCommand(worldId, {
            type: "quest.create",
            version: 1,
            user,
            payload,
            return: { quest: true },
        });
    }
    cmdQuestUpdate(worldId, payload, opts) {
        return this.enqueueCommand(worldId, {
            type: "quest.update",
            version: 1,
            user: opts?.user,
            ifMatch: opts?.ifMatch,
            payload,
            return: { quest: true },
        });
    }
    cmdQuestAssign(worldId, actorId, payload, user) {
        return this.enqueueCommand(worldId, {
            type: "quest.assign",
            version: 1,
            actorId,
            user,
            payload,
            return: { quest: true, actor: true },
        });
    }
    cmdQuestUnassign(worldId, actorId, payload, user) {
        return this.enqueueCommand(worldId, {
            type: "quest.unassign",
            version: 1,
            actorId,
            user,
            payload,
            return: { quest: true, actor: true },
        });
    }
    cmdQuestDelete(worldId, payload, user) {
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
    cmdIntelCreate(worldId, payload, user) {
        return this.enqueueCommand(worldId, {
            type: "intel.create",
            version: 1,
            user,
            payload,
            return: { intel: true },
        });
    }
    cmdIntelUpdate(worldId, payload, opts) {
        return this.enqueueCommand(worldId, {
            type: "intel.update",
            version: 1,
            user: opts?.user,
            ifMatch: opts?.ifMatch,
            payload,
            return: { intel: true },
        });
    }
    cmdIntelAssign(worldId, actorId, payload, user) {
        return this.enqueueCommand(worldId, {
            type: "intel.assign",
            version: 1,
            actorId,
            user,
            payload,
            return: { intel: true, actor: true },
        });
    }
    cmdIntelDelete(worldId, payload, user) {
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
    journalIndexPath(worldId, packId) {
        // keep for compatibility if other code calls it
        return this.packIndexPathCandidates(worldId, packId)[0];
    }
    /** Path to a payload JSON for a journal entry in a pack. */
    journalPayloadPath(worldId, packId, docId) {
        // Folder name on disk matches Foundry export: safeId(packId)
        // "world.vaultsync-intel" -> "worldvaultsync-intel"
        const packFolder = safeId(packId);
        const file = `${safeId(docId)}.json`;
        return `${this.worldRoot(worldId)}/packs/${packFolder}/payloads/${file}`;
    }
    async readJournalPayload(worldId, packId, docId) {
        const rel = this.journalPayloadPath(worldId, packId, docId);
        return (await this.exists(rel)) ? this.readJson(rel) : null;
    }
    /**
     * List journal templates in a pack from the pack index.
     * This is the “fast list view” for your app.
     */
    async listJournalTemplates(worldId, packId) {
        const idx = await this.readPackIndex(worldId, packId);
        if (!idx)
            return null;
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
    async readAllJournalPayloads(worldId, packId) {
        const listing = await this.listJournalTemplates(worldId, packId);
        if (!listing)
            return [];
        const payloads = [];
        for (const e of listing.entries) {
            const p = await this.readJournalPayload(worldId, packId, e.id);
            if (p)
                payloads.push(p);
        }
        return payloads;
    }
    /**
     * Read the deletion manifest produced by VaultSync export.
     * Your app can delete the listed files locally (Foundry can't).
     */
    async readDeleteManifest(worldId) {
        return this.readJsonLatestOrSingle(this.metaDir(worldId), "delete");
    }
}
/* -------------------------------------------- */
/* Singleton Export                             */
/* -------------------------------------------- */
export const vault = new VaultStore(config.vaultRoot);
//# sourceMappingURL=vaultStore.js.map