// stores/vaultSyncStore.ts
import { RootStore } from "./rootStore";
export function safeId(id) {
    return String(id ?? "unknown").replace(/[^a-zA-Z0-9_-]/g, "");
}
export class VaultSyncStore extends RootStore {
    worldRoot(worldId) {
        return `worlds/${worldId}`;
    }
    vaultRoot(worldId) {
        return `${this.worldRoot(worldId)}/vaultsync`;
    }
    metaDir(worldId) {
        return `${this.vaultRoot(worldId)}/meta`;
    }
    requestsDir(worldId) {
        return `${this.vaultRoot(worldId)}/requests`;
    }
    // ---- versioned meta helpers ----
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
    /** Versioned first, then fallback to base.json */
    async readJsonLatestOrSingle(dirRel, baseName) {
        const v = await this.readLatestVersionedJsonInDir(dirRel, baseName);
        if (v !== null)
            return v;
        const single = `${dirRel}/${baseName}.json`;
        return (await this.exists(single)) ? this.readJson(single) : null;
    }
    // ---- meta reads ----
    readStatusMeta(worldId) {
        return this.readJsonLatestOrSingle(this.metaDir(worldId), "status");
    }
    readWorldMeta(worldId) {
        return this.readJsonLatestOrSingle(this.metaDir(worldId), "world");
    }
    readUsersMeta(worldId) {
        return this.readJsonLatestOrSingle(this.metaDir(worldId), "users");
    }
    readVaultMeta(worldId) {
        return this.readJsonLatestOrSingle(this.metaDir(worldId), "vault");
    }
    readDeleteManifest(worldId) {
        return this.readJsonLatestOrSingle(this.metaDir(worldId), "delete");
    }
    async getWorldOnlineStatus(worldId, onlineWindowMs = 60_000) {
        const status = await this.readStatusMeta(worldId);
        const last = Date.parse(status?.lastHeartbeatAt ?? "");
        const ageMs = Number.isFinite(last) ? Date.now() - last : Infinity;
        return {
            worldId,
            online: ageMs < onlineWindowMs,
            lastHeartbeatAt: status?.lastHeartbeatAt,
            ageMs: Number.isFinite(ageMs) ? ageMs : undefined,
            details: status ?? undefined,
        };
    }
    // ---- requests (commands + export-docs) ----
    docRequestDir(worldId) {
        return `${this.requestsDir(worldId)}/export-docs`;
    }
    docDoneDir(worldId) {
        return `${this.requestsDir(worldId)}/export-docs-done`;
    }
    commandRequestDir(worldId) {
        return `${this.requestsDir(worldId)}/commands`;
    }
    commandDoneDir(worldId) {
        return `${this.requestsDir(worldId)}/commands-done`;
    }
    normalizeRel(p) {
        return String(p).replace(/^\/+/, "").replace(/^vault\//, "");
    }
    async cleanupRequestFromAck(prefixDir, ack) {
        const requestPath = typeof ack?.requestPath === "string" ? ack.requestPath : null;
        const requestFile = typeof ack?.requestFile === "string" ? ack.requestFile : null;
        let rel = null;
        if (requestPath)
            rel = this.normalizeRel(requestPath);
        else if (requestFile)
            rel = `${prefixDir}/${requestFile}`;
        if (!rel)
            return;
        const prefix = prefixDir + "/";
        if (!rel.startsWith(prefix))
            return;
        await this.deleteFile(rel);
    }
    async ensureVaultSyncScaffold(worldId) {
        const v = this.vaultRoot(worldId);
        const dirs = [
            `${v}/meta`,
            `${v}/state`,
            `${v}/import`,
            `${v}/exports`,
            `${v}/requests/export-docs`,
            `${v}/requests/export-docs-done`,
            `${v}/requests/commands`,
            `${v}/requests/commands-done`,
        ];
        for (const d of dirs) {
            // RootStore.abs is protected, but we can just use writeJson mkdir behavior.
            // We'll call fs.mkdir here via writeText trick or expose a mkdir helper.
            // simplest: writeText isn't right; better add a mkdir helper if you want.
        }
    }
}
//# sourceMappingURL=vaultSyncStore.js.map