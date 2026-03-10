// stores/vaultSyncStore.ts
import { RootStore } from "./rootStore.js";

export type WorldId = string;

export type WorldOnlineStatus = {
  worldId: string;
  online: boolean;
  lastHeartbeatAt?: string;
  ageMs?: number;
  details?: any;
};

export function safeId(id: string): string {
  return String(id ?? "unknown").replace(/[^a-zA-Z0-9_-]/g, "");
}

export class VaultSyncStore extends RootStore {
  worldRoot(worldId: WorldId) {
    return `worlds/${worldId}`;
  }

  vaultRoot(worldId: WorldId) {
    return `${this.worldRoot(worldId)}/vaultsync`;
  }

  metaDir(worldId: WorldId) {
    return `${this.vaultRoot(worldId)}/meta`;
  }

  requestsDir(worldId: WorldId) {
    return `${this.vaultRoot(worldId)}/requests`;
  }

  // ---- versioned meta helpers ----

  private parseVersionedTs(name: string, base: string): number | null {
    // base.ts.suffix.json
    if (!name.startsWith(base + ".")) return null;
    if (!name.endsWith(".json")) return null;
    const parts = name.split(".");
    if (parts.length < 4) return null;
    const ts = Number(parts[parts.length - 3]);
    return Number.isFinite(ts) ? ts : null;
  }

  private async readLatestVersionedJsonInDir<T>(dirRel: string, baseName: string): Promise<T | null> {
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

  /** Versioned first, then fallback to base.json */
  private async readJsonLatestOrSingle<T>(dirRel: string, baseName: string): Promise<T | null> {
    const v = await this.readLatestVersionedJsonInDir<T>(dirRel, baseName);
    if (v !== null) return v;

    const single = `${dirRel}/${baseName}.json`;
    return (await this.exists(single)) ? this.readJson<T>(single) : null;
  }

  // ---- meta reads ----

  readStatusMeta(worldId: WorldId) {
    return this.readJsonLatestOrSingle<any>(this.metaDir(worldId), "status");
  }
  readWorldMeta(worldId: WorldId) {
    return this.readJsonLatestOrSingle<any>(this.metaDir(worldId), "world");
  }
  readUsersMeta(worldId: WorldId) {
    return this.readJsonLatestOrSingle<any>(this.metaDir(worldId), "users");
  }
  readVaultMeta(worldId: WorldId) {
    return this.readJsonLatestOrSingle<any>(this.metaDir(worldId), "vault");
  }
  readDeleteManifest(worldId: WorldId) {
    return this.readJsonLatestOrSingle<any>(this.metaDir(worldId), "delete");
  }

  async getWorldOnlineStatus(worldId: WorldId, onlineWindowMs = 60_000): Promise<WorldOnlineStatus> {
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

  docRequestDir(worldId: WorldId) {
    return `${this.requestsDir(worldId)}/export-docs`;
  }
  docDoneDir(worldId: WorldId) {
    return `${this.requestsDir(worldId)}/export-docs-done`;
  }
  commandRequestDir(worldId: WorldId) {
    return `${this.requestsDir(worldId)}/commands`;
  }
  commandDoneDir(worldId: WorldId) {
    return `${this.requestsDir(worldId)}/commands-done`;
  }

  private normalizeRel(p: string) {
    return String(p).replace(/^\/+/, "").replace(/^vault\//, "");
  }

  async cleanupRequestFromAck(prefixDir: string, ack: any): Promise<void> {
    const requestPath = typeof ack?.requestPath === "string" ? ack.requestPath : null;
    const requestFile = typeof ack?.requestFile === "string" ? ack.requestFile : null;

    let rel: string | null = null;
    if (requestPath) rel = this.normalizeRel(requestPath);
    else if (requestFile) rel = `${prefixDir}/${requestFile}`;
    if (!rel) return;

    const prefix = prefixDir + "/";
    if (!rel.startsWith(prefix)) return;

    await this.deleteFile(rel);
  }

  async ensureVaultSyncScaffold(worldId: WorldId): Promise<void> {
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
