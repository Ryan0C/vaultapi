// src/stores/packsStore.ts
import path from "node:path";
import fs from "node:fs/promises";
export class PacksStore {
    opts;
    constructor(opts) {
        this.opts = opts;
    }
    abs(rel) {
        const cleaned = String(rel ?? "").replace(/^\/+/, "");
        const out = path.resolve(this.opts.foundryDataRoot, cleaned);
        const root = path.resolve(this.opts.foundryDataRoot);
        if (!out.startsWith(root + path.sep) && out !== root) {
            throw new Error(`PacksStore: path escapes root: ${rel}`);
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
    async readJson(rel) {
        const txt = await fs.readFile(this.abs(rel), "utf-8");
        return JSON.parse(txt);
    }
    async listDirs(rel) {
        const entries = await fs.readdir(this.abs(rel), { withFileTypes: true });
        return entries.filter(e => e.isDirectory()).map(e => e.name);
    }
    async listFilesSafe(rel) {
        try {
            const entries = await fs.readdir(this.abs(rel), { withFileTypes: true });
            return entries.filter(e => e.isFile()).map(e => e.name);
        }
        catch {
            return [];
        }
    }
    // worlds/<worldId>/vaultsync/exports/<exportName>
    exportRoot(worldId, exportName) {
        return `worlds/${worldId}/vaultsync/exports/${exportName}`;
    }
    // ---- Items export (world items) ----
    itemsExportIndexPath(worldId) {
        return `${this.exportRoot(worldId, "items")}/index.json`;
    }
    async readItemsExportIndex(worldId) {
        const rel = this.itemsExportIndexPath(worldId);
        if (!(await this.exists(rel)))
            return null;
        return this.readJson(rel);
    }
    /**
     * Read the latest exported snapshot file for a world Item.
     * Uses exports/items/index.json -> items[externalId].latestFile
     */
    async readWorldItemByExternalId(worldId, externalId) {
        const idx = await this.readItemsExportIndex(worldId);
        const rec = idx?.items?.[externalId];
        const latestFile = typeof rec?.latestFile === "string" ? rec.latestFile : null;
        if (!latestFile)
            return null;
        // latestFile is already a rel path like "worlds/<id>/vaultsync/exports/items/item....json"
        if (!(await this.exists(latestFile)))
            return null;
        return this.readJson(latestFile);
    }
    // ---- Compendium packs under exports/items/packs ----
    itemsPacksDir(worldId) {
        return `${this.exportRoot(worldId, "items")}/packs`;
    }
    async listItemPackIds(worldId) {
        const rel = this.itemsPacksDir(worldId);
        if (!(await this.exists(rel)))
            return [];
        return (await this.listDirs(rel)).sort((a, b) => a.localeCompare(b));
    }
    parseVersionedTs(name, base) {
        // base.ts.suffix.json  e.g. index.1772523553914.kwiu0f.json
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
    async readLatestItemPackIndex(worldId, packId) {
        const dirRel = `${this.itemsPacksDir(worldId)}/${packId}`;
        const files = await this.listFilesSafe(dirRel);
        let best = null;
        for (const f of files) {
            const ts = this.parseVersionedTs(f, "index");
            if (ts == null)
                continue;
            if (!best || ts > best.ts)
                best = { f, ts };
        }
        if (!best)
            return null;
        return this.readJson(`${dirRel}/${best.f}`);
    }
}
//# sourceMappingURL=packsStore.js.map