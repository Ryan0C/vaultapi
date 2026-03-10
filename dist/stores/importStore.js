import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { createLogger } from "../services/logger.js";
const logger = createLogger(process.env.LOG_LEVEL ?? "info");
export function safeId(id) {
    return String(id ?? "unknown").replace(/[^a-zA-Z0-9_-]/g, "");
}
function safeImportId(id) {
    return String(id ?? "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
}
function nonce(len = 6) {
    return crypto.randomBytes(6).toString("base64url").slice(0, len).toLowerCase();
}
export class ImportsStore {
    dataRoot;
    constructor(opts) {
        const root = opts.dataRoot ?? opts.foundryDataRoot ?? "";
        this.dataRoot = path.resolve(String(root));
        logger.info("importsStore.init", { dataRoot: this.dataRoot });
    }
    abs(rel) {
        const cleaned = String(rel ?? "").replace(/^\/+/, "");
        const out = path.resolve(this.dataRoot, cleaned);
        const root = path.resolve(this.dataRoot);
        if (!out.startsWith(root + path.sep) && out !== root) {
            throw new Error(`ImportsStore: path escapes root: ${rel}`);
        }
        return out;
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
    async isDir(rel) {
        try {
            return (await fs.stat(this.abs(rel))).isDirectory();
        }
        catch {
            return false;
        }
    }
    async writeJson(rel, value) {
        const abs = this.abs(rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, JSON.stringify(value, null, 2), "utf-8");
    }
    async listFilesSafe(rel) {
        try {
            return await fs.readdir(this.abs(rel));
        }
        catch {
            return [];
        }
    }
    toArray(value) {
        if (Array.isArray(value))
            return value;
        if (value && typeof value === "object") {
            const obj = value;
            if (Array.isArray(obj.records))
                return obj.records;
            if (Array.isArray(obj.items))
                return obj.items;
        }
        return [];
    }
    pickRepresentativeRecord(payload) {
        if (!payload || typeof payload !== "object")
            return null;
        if (typeof payload.docType === "string")
            return payload;
        if (typeof payload.type === "string" && payload.type !== "request" && payload.type !== "command")
            return payload;
        const arr = this.toArray(payload);
        for (const x of arr) {
            if (!x || typeof x !== "object")
                continue;
            if (typeof x.docType === "string")
                return x;
            if (typeof x.type === "string")
                return x;
        }
        return null;
    }
    inferDocType(entityType, payload) {
        if (entityType) {
            const et = entityType.toLowerCase();
            if (et === "actor")
                return "Actor";
            if (et === "item")
                return "Item";
            if (et === "chat" || et === "chatmessage" || et === "message")
                return "ChatMessage";
            if (et === "journalentry" || et === "entry")
                return "JournalEntry";
            if (et === "journalpage" || et === "page")
                return "JournalPage";
        }
        const r = this.pickRepresentativeRecord(payload);
        const rawDocType = String(r?.docType ?? "").trim();
        if (rawDocType)
            return rawDocType;
        const typed = String(r?.type ?? "").trim().toLowerCase();
        if (typed === "actor")
            return "Actor";
        if (typed === "item")
            return "Item";
        if (typed === "chat" || typed === "chatmessage")
            return "ChatMessage";
        return "";
    }
    inferPrefix(type, entityType, payload) {
        const docType = this.inferDocType(entityType, payload).toLowerCase();
        if (docType === "actor")
            return "actor";
        if (docType === "item")
            return "item";
        if (docType === "chatmessage")
            return "chat";
        if (docType === "journalpage" || docType === "journalentrypage")
            return "page";
        if (docType === "journalentry")
            return "entry";
        const et = String(entityType ?? "").trim().toLowerCase();
        if (et)
            return safeId(et) || "import";
        return safeId(type || "import") || "import";
    }
    parseIdFromUuid(uuid) {
        const s = String(uuid ?? "").trim();
        if (!s)
            return null;
        const parts = s.split(".");
        const last = parts[parts.length - 1];
        return last ? safeId(last) || null : null;
    }
    extractFoundryObject(payload) {
        if (!payload || typeof payload !== "object")
            return null;
        if (payload.foundry && typeof payload.foundry === "object")
            return payload.foundry;
        if (payload.data && typeof payload.data === "object")
            return payload.data;
        return null;
    }
    /**
     * Build a proper ImportOp envelope (type: "import") for the inbox.
     *
     * The VaultSync contract distinguishes:
     *   ExportRecord  { type: "export", ... } — written by the export pipeline
     *   ImportOp      { type: "import", opId, mode, createdAt, ... } — written to inbox
     *
     * vaultsync's normalizeImportPayload() (after the matching fix) checks for
     * type === "import" first, then falls back to type === "export".
     *
     * Accepted input shapes:
     *  1. Already a proper ExportRecord (type: "export", docType, foundry) — converted to ImportOp
     *  2. Already a proper ImportOp (type: "import", docType, foundry) — passed through as-is
     *  3. Raw Foundry document data — wrapped using entityType hint
     */
    buildInboxEnvelope(input) {
        const p = input.payload;
        // ── Case: Already a proper ImportOp – pass through unchanged ──────────────
        if (p &&
            typeof p === "object" &&
            p.type === "import" &&
            typeof p.docType === "string" &&
            "foundry" in p) {
            return p;
        }
        // ── Extract shared fields (works for ExportRecord or raw Foundry data) ────
        // Infer docType from entityType hint (most reliable), then inspect payload
        const docType = this.inferDocType(input.entityType, p) ||
            input.entityType ||
            "Unknown";
        // Extract uuid — try the payload itself, then nested foundry/data wrappers
        const payloadUuid = (() => {
            const raw = p?.uuid ??
                p?.foundry?.uuid ??
                p?.data?.uuid;
            const s = String(raw ?? "").trim();
            return s || undefined;
        })();
        // Extract externalId — payload field wins; fall back to the ORIGINAL
        // (unsanitized) entity ID so colon-containing IDs like "vh:Actor:abc123"
        // are preserved. The sanitized entityId is only used for filenames.
        const payloadExternalId = (() => {
            // 1. Best: externalId explicitly present in the payload
            const fromPayload = String(p?.externalId ?? "").trim();
            if (fromPayload)
                return fromPayload;
            // 2. For ExportRecords vaulthero might have sent
            const fromEnv = String(p?.foundry?.externalId ?? "").trim();
            if (fromEnv)
                return fromEnv;
            // 3. Original (unsanitized) entity ID from the API caller
            const rawId = String(input.rawEntityId ?? "").trim();
            if (rawId)
                return rawId;
            // 4. Fallback to sanitized ID if nothing else
            return input.entityId !== "unknown" ? input.entityId : undefined;
        })();
        // The "foundry" field must be the raw Foundry document data.
        // Unwrap from "foundry" / "data" wrappers if present; otherwise the
        // whole payload IS the Foundry document (raw actor JSON etc.).
        const foundryData = (() => {
            if (p && typeof p === "object") {
                // ExportRecord: { type: "export", foundry: {...} }
                if (p.type === "export" && typeof p.foundry === "object" && p.foundry)
                    return p.foundry;
                // Generic { foundry: {...} } wrapper
                if (typeof p.foundry === "object" && p.foundry)
                    return p.foundry;
                // Generic { data: {...} } wrapper
                if (typeof p.data === "object" && p.data)
                    return p.data;
            }
            // Raw Foundry document (actor object, item object, etc.)
            return p;
        })();
        // ── Build ImportOp ─────────────────────────────────────────────────────────
        return {
            type: "import",
            contractVersion: 1,
            docType,
            uuid: payloadUuid,
            externalId: payloadExternalId,
            foundry: foundryData,
            opId: crypto.randomUUID(),
            mode: "upsert",
            createdAt: Date.now(),
        };
    }
    inferEntityId(input) {
        const explicit = safeId(input.entityId ?? "");
        if (explicit)
            return explicit;
        const r = this.pickRepresentativeRecord(input.payload);
        if (r) {
            const fromExternal = safeId(String(r.externalId ?? ""));
            if (fromExternal)
                return fromExternal;
            const fromUuid = this.parseIdFromUuid(r.uuid);
            if (fromUuid)
                return fromUuid;
        }
        const doc = this.extractFoundryObject(r ?? input.payload);
        if (doc) {
            const fromDoc = safeId(String(doc._id ?? doc.id ?? ""));
            if (fromDoc)
                return fromDoc;
        }
        const req = safeId(input.requestId ?? "");
        if (req)
            return req;
        return "unknown";
    }
    async findAckMatch(baseDir, importId) {
        const inboxFile = `${importId}.json`;
        const prefix = `${inboxFile}.`;
        const dirs = [baseDir, `${baseDir}/_done`];
        for (const dir of dirs) {
            const files = await this.listFilesSafe(dir);
            const match = files
                .filter(f => f.startsWith(prefix) && f.endsWith(".done.json"))
                .sort((a, b) => b.localeCompare(a))[0];
            if (!match)
                continue;
            try {
                const relPath = `${dir}/${match}`;
                const data = JSON.parse(await fs.readFile(this.abs(relPath), "utf-8"));
                return { relPath, file: match, data };
            }
            catch {
                continue;
            }
        }
        return null;
    }
    /* -------------------------------------------- */
    /* World root                                   */
    /* -------------------------------------------- */
    worldRootCandidates(worldId) {
        const wid = String(worldId ?? "").trim().replace(/^\/+/, "");
        return [`worlds/${wid}`, `vault/worlds/${wid}`];
    }
    async pickWorldRoot(worldId) {
        for (const base of this.worldRootCandidates(worldId)) {
            if (await this.exists(base) && await this.isDir(base))
                return base;
        }
        return null;
    }
    /* -------------------------------------------- */
    /* Directory helpers                            */
    /* -------------------------------------------- */
    async inboxDir(worldId) {
        const root = await this.pickWorldRoot(worldId);
        return root ? `${root}/vaultsync/import/inbox` : null;
    }
    async processedDir(worldId) {
        const root = await this.pickWorldRoot(worldId);
        return root ? `${root}/vaultsync/import/processed` : null;
    }
    async failedDir(worldId) {
        const root = await this.pickWorldRoot(worldId);
        return root ? `${root}/vaultsync/import/failed` : null;
    }
    /* -------------------------------------------- */
    /* Public API                                   */
    /* -------------------------------------------- */
    async createImport(worldId, input) {
        const wid = String(worldId ?? "").trim();
        const entityType = String(input.entityType ?? "").trim();
        const entityId = this.inferEntityId(input);
        const prefix = this.inferPrefix(input.type, entityType, input.payload);
        logger.info("importsStore.createImport.start", { worldId: wid, type: input.type, entityType, entityId, prefix });
        const inboxDir = await this.inboxDir(wid);
        if (!inboxDir) {
            logger.warn("importsStore.createImport.worldNotFound", { worldId: wid });
            return { ok: false, error: "World not found" };
        }
        await fs.mkdir(this.abs(inboxDir), { recursive: true });
        const id = `${safeId(prefix || "import")}.${safeId(entityId || "unknown")}.${Date.now()}.${nonce()}`;
        const file = `${inboxDir}/${id}.json`;
        // Build a proper ImportOp envelope for the inbox.
        // Note: entityId is sanitized (safe for filenames) but the original input.entityId
        // may contain characters like ":" that are stripped by safeId. We pass both so
        // buildInboxEnvelope can use the original (unsanitized) value as the externalId in
        // the ImportOp — vaultsync's findActorByExternalId needs the raw flag value.
        const record = this.buildInboxEnvelope({
            type: input.type,
            entityType,
            entityId, // sanitized – used only for filename
            rawEntityId: input.entityId ?? null, // original – used as ImportOp.externalId
            payload: input.payload,
            requestId: input.requestId,
        });
        logger.info("importsStore.createImport.write", {
            worldId: wid,
            file,
            docType: record.docType,
            isWrapped: record._vaultWrapped === true,
            topLevelKeys: Object.keys(record),
        });
        await this.writeJson(file, record);
        return {
            ok: true,
            id,
            envelope: {
                id,
                worldId: wid,
                file,
                type: input.type,
                entityType: entityType || null,
                entityId,
                source: input.source ?? "api",
                meta: input.meta ?? {},
                createdAt: new Date().toISOString(),
                status: "pending",
            },
        };
    }
    async readImport(worldId, importId) {
        const inboxDir = await this.inboxDir(worldId);
        if (!inboxDir)
            return null;
        const rel = `${inboxDir}/${safeImportId(importId)}.json`;
        if (!(await this.exists(rel)))
            return null;
        try {
            return JSON.parse(await fs.readFile(this.abs(rel), "utf-8"));
        }
        catch {
            return null;
        }
    }
    /**
     * Read ack for an import.
     *
     * VaultSync watcher writes markers to import/processed/ or import/failed/
     * using tombstone() which names files: {inboxFile}.{ts}.{rand}.done.json
     * where inboxFile = {importId}.json
     *
     * So we scan processed/ and failed/ for files starting with "{importId}.json."
     */
    async readAck(worldId, importId) {
        const processedDir = await this.processedDir(worldId);
        if (processedDir) {
            const found = await this.findAckMatch(processedDir, safeImportId(importId));
            if (found) {
                return {
                    id: importId,
                    worldId,
                    status: "processed",
                    ok: found.data?.ok !== false,
                    file: found.file,
                    path: found.relPath,
                    ...found.data,
                };
            }
        }
        const failedDir = await this.failedDir(worldId);
        if (failedDir) {
            const found = await this.findAckMatch(failedDir, safeImportId(importId));
            if (found) {
                return {
                    id: importId,
                    worldId,
                    status: "failed",
                    ok: false,
                    file: found.file,
                    path: found.relPath,
                    ...found.data,
                };
            }
        }
        return null;
    }
    async getImportStatus(worldId, importId) {
        const ack = await this.readAck(worldId, importId);
        if (ack)
            return ack;
        const env = await this.readImport(worldId, importId);
        if (env) {
            return { id: importId, worldId, ok: true, status: "pending", result: null, error: null };
        }
        return { id: importId, worldId, ok: false, status: "not_found", error: "Import not found" };
    }
    async listInbox(worldId) {
        const inboxDir = await this.inboxDir(worldId);
        if (!inboxDir || !(await this.exists(inboxDir)))
            return [];
        const files = await fs.readdir(this.abs(inboxDir));
        return files.filter(f => f.endsWith(".json")).sort((a, b) => b.localeCompare(a));
    }
    async listAcks(worldId) {
        const processedDir = await this.processedDir(worldId);
        const failedDir = await this.failedDir(worldId);
        const [processed, processedDone, failed, failedDone] = await Promise.all([
            processedDir ? this.listFilesSafe(processedDir) : Promise.resolve([]),
            processedDir ? this.listFilesSafe(`${processedDir}/_done`) : Promise.resolve([]),
            failedDir ? this.listFilesSafe(failedDir) : Promise.resolve([]),
            failedDir ? this.listFilesSafe(`${failedDir}/_done`) : Promise.resolve([]),
        ]);
        return [...processed, ...processedDone, ...failed, ...failedDone]
            .filter(f => f.endsWith(".done.json"))
            .sort((a, b) => b.localeCompare(a));
    }
    /* -------------------------------------------- */
    /* Cleanup                                      */
    /* -------------------------------------------- */
    /**
     * Parse the group key and embedded timestamp from a vault filename.
     *
     * All VaultSync file names follow this pattern (written by both VaultSync
     * and VaultAPI):
     *
     *   {prefix}.{entityId}.{epochMs≥10digits}.{nonce}.json
     *
     * Group key  : "{prefix}.{entityId}" — everything before the timestamp
     * Timestamp  : used to determine which file is newest
     *
     * Returns null for any file that doesn't match (e.g. _manifest, _done dirs).
     */
    parseVaultFileName(name) {
        if (!name.endsWith(".json"))
            return null;
        const base = name.slice(0, -5); // strip .json
        const parts = base.split(".");
        // Need at least: prefix, entityId, ts, nonce → 4 segments
        if (parts.length < 4)
            return null;
        const tsStr = parts[parts.length - 2];
        if (!/^\d{10,}$/.test(tsStr))
            return null;
        return {
            key: parts.slice(0, parts.length - 2).join("."),
            ts: parseInt(tsStr, 10),
        };
    }
    /**
     * For every group of files sharing the same {prefix}.{entityId} key, keep
     * the `keepNewest` most-recent entries (ordered by embedded timestamp) and
     * delete the rest.
     *
     * Files that don't match the naming pattern (e.g. _manifest, subdirs) are
     * left untouched.
     *
     * @returns number of files deleted
     */
    async dedupeDir(absDir, keepNewest = 1) {
        let names;
        try {
            names = await fs.readdir(absDir);
        }
        catch {
            return 0;
        }
        // Group matching files by their {prefix}.{entityId} key
        const groups = new Map();
        for (const name of names) {
            const parsed = this.parseVaultFileName(name);
            if (!parsed)
                continue;
            const group = groups.get(parsed.key) ?? [];
            group.push({ name, ts: parsed.ts });
            groups.set(parsed.key, group);
        }
        let deleted = 0;
        for (const [, entries] of groups) {
            // Sort descending — newest (largest ts) first
            entries.sort((a, b) => b.ts - a.ts);
            // Delete everything beyond the newest `keepNewest`
            for (const entry of entries.slice(keepNewest)) {
                try {
                    await fs.unlink(path.join(absDir, entry.name));
                    deleted++;
                }
                catch {
                    // File may already have been removed by a concurrent pass — ignore
                }
            }
        }
        return deleted;
    }
    /**
     * Extract the inbox filename from a marker filename.
     *
     * Marker format (written by vaultsync tombstone()):
     *   {safeInboxFile}.{ts13}.{rand6}.done.json
     *
     * Inbox file names only contain [a-zA-Z0-9._-] so safeInboxFile == inboxFile.
     * We strip the trailing `.{ts}.{rand}.done.json` to recover the inbox filename.
     */
    inboxFileFromMarker(markerName) {
        if (!markerName.endsWith(".done.json"))
            return null;
        const stripped = markerName.slice(0, -".done.json".length);
        const parts = stripped.split(".");
        if (parts.length < 3)
            return null;
        const ts = parts[parts.length - 2];
        const rand = parts[parts.length - 1];
        if (!/^\d{10,}$/.test(ts) || !rand.length)
            return null;
        return parts.slice(0, parts.length - 2).join(".");
    }
    /**
     * Attempt to delete a file.
     *
     * Returns:
     *   "deleted"   – file existed and was removed
     *   "not_found" – file was already absent (ENOENT) — safe to proceed
     *   "error"     – unexpected I/O error, do NOT remove dependent files
     */
    async tryDelete(rel) {
        try {
            await fs.unlink(this.abs(rel));
            return "deleted";
        }
        catch (err) {
            if (err?.code === "ENOENT")
                return "not_found";
            return "error";
        }
    }
    /**
     * Clean up a single world's vaultsync directories.
     *
     * Three-pass strategy:
     *
     * 1. ACK-based  – delete inbox files that VaultSync has already processed
     *    (has a marker in processed/ or processed/_done, failed/ or failed/_done).
     *    Also deletes the marker files so those dirs don't grow unboundedly.
     *
     * 2. Inbox dedup – for each actor/item/etc., keep only the newest inbox file;
     *    delete all older duplicates.  VaultSync cannot delete files itself, so
     *    they pile up on every export cycle.
     *
     * 3. Exports + meta rotation – same dedup pass on exports/actors, exports/items,
     *    exports/journal, exports/chat, and meta directories so historical snapshots
     *    don't accumulate forever.
     */
    async cleanupWorld(worldId) {
        const wid = String(worldId ?? "").trim();
        let inboxRemoved = 0;
        let markersRemoved = 0;
        const inboxDir = await this.inboxDir(wid);
        const processedDir = await this.processedDir(wid);
        const failedDir = await this.failedDir(wid);
        const root = await this.pickWorldRoot(wid);
        if (!inboxDir || !root) {
            return { inbox: 0, markers: 0, dedupedInbox: 0, dedupedExports: 0, dedupedMeta: 0 };
        }
        // ── Pass 1: ACK-based cleanup ────────────────────────────────────────────
        // Scan both the parent dir and _done subdir — VaultSync may write markers
        // to either location depending on the tombstone() call site.
        const markerDirs = [];
        if (processedDir) {
            markerDirs.push(processedDir, `${processedDir}/_done`);
        }
        if (failedDir) {
            markerDirs.push(failedDir, `${failedDir}/_done`);
        }
        for (const markerDir of markerDirs) {
            const markers = await this.listFilesSafe(markerDir);
            for (const markerFile of markers) {
                if (!markerFile.endsWith(".done.json"))
                    continue;
                const inboxFile = this.inboxFileFromMarker(markerFile);
                if (!inboxFile)
                    continue;
                const inboxResult = await this.tryDelete(`${inboxDir}/${inboxFile}`);
                if (inboxResult === "deleted")
                    inboxRemoved++;
                // Only remove the marker once the inbox file is confirmed gone.
                // If the inbox deletion returned "error" (unexpected I/O failure),
                // leave the marker intact so VaultSync keeps recognising the file
                // as already-processed rather than reprocessing it on the next tick.
                if (inboxResult !== "error") {
                    const markerResult = await this.tryDelete(`${markerDir}/${markerFile}`);
                    if (markerResult === "deleted")
                        markersRemoved++;
                }
            }
        }
        // ── Pass 2: Inbox dedup — keep newest 1 per entity ──────────────────────
        const dedupedInbox = await this.dedupeDir(this.abs(inboxDir), 1);
        // ── Pass 3: Export + meta dedup ──────────────────────────────────────────
        const exportBase = `${root}/vaultsync/exports`;
        let dedupedExports = 0;
        for (const sub of ["actors", "items", "journal", "chat"]) {
            dedupedExports += await this.dedupeDir(this.abs(`${exportBase}/${sub}`), 1);
        }
        // Meta files (status snapshots) — keep the 20 most recent globally
        const dedupedMeta = await this.dedupeDir(this.abs(`${root}/vaultsync/meta`), 20);
        if (inboxRemoved || markersRemoved || dedupedInbox || dedupedExports || dedupedMeta) {
            logger.info("importsStore.cleanup", {
                worldId: wid,
                inboxRemoved,
                markersRemoved,
                dedupedInbox,
                dedupedExports,
                dedupedMeta,
            });
        }
        return { inbox: inboxRemoved, markers: markersRemoved, dedupedInbox, dedupedExports, dedupedMeta };
    }
    /**
     * Discover all world IDs that have a vaultsync inbox directory and clean them all.
     */
    async cleanupAllWorlds() {
        const results = {};
        for (const base of ["worlds", "vault/worlds"]) {
            let entries;
            try {
                entries = await fs.readdir(this.abs(base));
            }
            catch {
                continue;
            }
            for (const entry of entries) {
                const inboxRel = `${base}/${entry}/vaultsync/import/inbox`;
                if (!(await this.exists(inboxRel)))
                    continue;
                results[entry] = await this.cleanupWorld(entry);
            }
        }
        return results;
    }
}
//# sourceMappingURL=importStore.js.map