// stores/actorsStore.ts
import path from "node:path";
import fs from "node:fs/promises";
import { createLogger } from "../services/logger.js";

const logger = createLogger((process.env.LOG_LEVEL as any) ?? "info");

export type WorldId = string;

export type ActorsStoreOptions = {
  /** Absolute path to Foundry UserData root (.../Data directory). */
  dataRoot: string;
  // Legacy options kept for compat
  vaultDirName?: string;
  allowLegacyWorldRoot?: boolean;
};

export class ActorsStore {
  private dataRoot: string;

  constructor(opts: ActorsStoreOptions) {
    this.dataRoot = path.resolve(String(opts.dataRoot ?? ""));
  }

  /* -------------------------------------------- */
  /* Path helpers                                 */
  /* -------------------------------------------- */

  private abs(rel: string): string {
    const cleaned = String(rel ?? "").replace(/^\/+/, "");
    const out = path.resolve(this.dataRoot, cleaned);
    const root = path.resolve(this.dataRoot);
    if (!out.startsWith(root + path.sep) && out !== root) {
      throw new Error(`ActorsStore: path escapes root: ${rel}`);
    }
    return out;
  }

  private async exists(rel: string): Promise<boolean> {
    try { await fs.access(this.abs(rel)); return true; } catch { return false; }
  }

  private async readJson<T = any>(rel: string): Promise<T> {
    return JSON.parse(await fs.readFile(this.abs(rel), "utf-8")) as T;
  }

  private async listFilesSafe(rel: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.abs(rel), { withFileTypes: true });
      return entries.filter(e => e.isFile()).map(e => e.name);
    } catch { return []; }
  }

  /** worlds/{worldId}/vaultsync/exports/actors */
  private actorsExportDir(worldId: WorldId): string {
    return `worlds/${worldId}/vaultsync/exports/actors`;
  }

  /* -------------------------------------------- */
  /* Versioned manifest reading                   */
  /* -------------------------------------------- */

  private parseVersionedTs(name: string, base: string): number | null {
    if (!name.startsWith(base + ".") || !name.endsWith(".json")) return null;
    const parts = name.split(".");
    if (parts.length < 4) return null;
    const ts = Number(parts[parts.length - 3]);
    return Number.isFinite(ts) ? ts : null;
  }

  /**
   * Read actor manifest from:
   *   exports/actors/index.json            (stable overwrite attempt)
   *   exports/actors/_manifest/index.*.json (versioned fallback)
   */
  private async readRawManifest(worldId: WorldId): Promise<any | null> {
    const dir = this.actorsExportDir(worldId);

    const stableRel = `${dir}/index.json`;
    if (await this.exists(stableRel)) {
      try { return await this.readJson(stableRel); } catch {}
    }

    const vDir = `${dir}/_manifest`;
    const files = await this.listFilesSafe(vDir);
    let best: { f: string; ts: number } | null = null;
    for (const f of files) {
      if (!f.startsWith("index.") || !f.endsWith(".json")) continue;
      const ts = this.parseVersionedTs(f, "index");
      if (ts == null) continue;
      if (!best || ts > best.ts) best = { f, ts };
    }
    if (!best) return null;

    try { return await this.readJson(`${vDir}/${best.f}`); } catch { return null; }
  }

  /* -------------------------------------------- */
  /* Public API                                   */
  /* -------------------------------------------- */

  /**
   * Returns { worldId, count, actors: [{id, uuid, externalId, name, type, ...}], generatedAt }
   * Shape expected by the actors route.
   */
  async readActorsManifest(worldId: WorldId): Promise<any | null> {
    const raw = await this.readRawManifest(worldId);
    if (!raw) {
      logger.warn("actors.readActorsManifest: no manifest found", { worldId });
      return null;
    }

    const actorsObj: Record<string, any> = raw?.actors ?? {};
    const actors = Object.values(actorsObj).map((item: any) => ({
      id: item.id ?? item.key,
      uuid: item.uuid,
      externalId: item.externalId,
      name: item.name,
      type: item.type,
      updatedAt: item.updatedAt,
      exportedAt: item.exportedAt,
    })).filter(a => a.id);

    return {
      worldId: raw.worldId ?? worldId,
      count: actors.length,
      actors,
      generatedAt: raw.generatedAt,
      moduleId: raw.moduleId,
    };
  }

  /**
   * List actor ids from manifest, or fall back to directory scan.
   */
  async listActorIds(worldId: WorldId): Promise<string[]> {
    const raw = await this.readRawManifest(worldId);
    if (raw?.actors) {
      return Object.values(raw.actors as Record<string, any>)
        .map((item: any) => item.id ?? item.key)
        .filter(Boolean)
        .sort((a: string, b: string) => a.localeCompare(b));
    }

    // Fallback: scan directory for actor.{id}.{ts}.{rand}.json
    const dir = this.actorsExportDir(worldId);
    const files = await this.listFilesSafe(dir);
    const ids = new Set<string>();
    for (const f of files) {
      if (!f.startsWith("actor.") || !f.endsWith(".json")) continue;
      const parts = f.split(".");
      if (parts.length < 4) continue;
      const id = parts[1];
      if (id) ids.add(id);
    }
    return [...ids].sort();
  }

  /**
   * Read latest actor ExportRecord by actorId.
   * Resolves latestFile from manifest; falls back to directory scan.
   */
  async readActor(worldId: WorldId, actorId: string): Promise<any | null> {
    const raw = await this.readRawManifest(worldId);

    if (raw?.actors) {
      for (const item of Object.values(raw.actors as Record<string, any>)) {
        const i = item as any;
        if (i.id !== actorId && i.externalId !== actorId) continue;
        const latestFile = typeof i.latestFile === "string" ? i.latestFile : null;
        if (latestFile && await this.exists(latestFile)) {
          try { return await this.readJson(latestFile); } catch {}
        }
      }
    }

    // Fallback: find latest actor.{actorId}.{ts}.{rand}.json
    const dir = this.actorsExportDir(worldId);
    const files = await this.listFilesSafe(dir);
    const base = `actor.${actorId}`;
    let best: { f: string; ts: number } | null = null;
    for (const f of files) {
      if (!f.startsWith(base + ".") || !f.endsWith(".json")) continue;
      const ts = this.parseVersionedTs(f, base);
      if (ts == null) continue;
      if (!best || ts > best.ts) best = { f, ts };
    }
    if (!best) {
      logger.warn("actors.readActor: not found", { worldId, actorId });
      return null;
    }

    try { return await this.readJson(`${dir}/${best.f}`); } catch { return null; }
  }

  /**
   * Check for tombstone in exports/actors/_done/.
   * Tombstone filename written by hooks.ts: Actor.{id}.{ts}.{rand}.done.json
   */
  async readActorTombstone(worldId: WorldId, actorId: string): Promise<any | null> {
    const doneDir = `${this.actorsExportDir(worldId)}/_done`;
    const files = await this.listFilesSafe(doneDir);

    for (const f of files) {
      if (!f.endsWith(".done.json")) continue;
      if (!f.includes(actorId)) continue;

      try {
        const data = await this.readJson<any>(`${doneDir}/${f}`);
        if (
          data?.uuid?.includes(actorId) ||
          data?.externalId?.includes(actorId) ||
          f.includes(`Actor.${actorId}`) ||
          f.includes(`Actor_${actorId}`)
        ) {
          return { ...data, file: f };
        }
      } catch {}
    }
    return null;
  }

  async resolveActorsWorldRoot(worldId: WorldId): Promise<string | null> {
    const dir = this.actorsExportDir(worldId);
    return (await this.exists(dir)) ? dir : null;
  }
}
