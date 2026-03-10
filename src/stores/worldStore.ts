// @ts-nocheck
// stores/worldStore.ts
import { RootStore } from "./rootStore";

export type WorldId = string;

export class WorldStore extends RootStore {
  /* -------------------------------------------- */
  /* Core layout helpers                          */
  /* -------------------------------------------- */

  worldRoot(worldId: WorldId) {
    return `worlds/${worldId}`;
  }

  worldJsonPath(worldId: WorldId) {
    return `${this.worldRoot(worldId)}/world.json`;
  }

  /** Foundry "world data" folder (actors, items, etc) */
  dataDir(worldId: WorldId) {
    return `${this.worldRoot(worldId)}/data`;
  }

  /* -------------------------------------------- */
  /* Actors (foundry world/data/actors)           */
  /* -------------------------------------------- */

  actorsDir(worldId: WorldId) {
    return `${this.dataDir(worldId)}/actors`;
  }

  actorPath(worldId: WorldId, actorId: string) {
    return `${this.actorsDir(worldId)}/${actorId}.json`;
  }

  async readActor(worldId: WorldId, actorId: string) {
    const rel = this.actorPath(worldId, actorId);
    return (await this.exists(rel)) ? this.readJson(rel) : null;
  }

  async listActorIds(worldId: WorldId): Promise<string[]> {
    const dir = this.actorsDir(worldId);
    if (!(await this.exists(dir))) return [];
    const files = await this.listFiles(dir);
    return files
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/i, ""))
      .sort((a, b) => a.localeCompare(b));
  }

  /* -------------------------------------------- */
  /* Packs                                        */
  /* -------------------------------------------- */

  packsDir(worldId: WorldId) {
    return `${this.worldRoot(worldId)}/packs`;
  }

  packIndexPathCandidates(worldId: WorldId, safePackId: string) {
    const p = this.packsDir(worldId);
    return [
      `${p}/${safePackId}.index.json`,
      `${p}/${safePackId}/index.json`,
      `${p}/${safePackId}/pack.index.json`,
    ];
  }

  async readPackIndex(worldId: WorldId, safePackId: string): Promise<any | null> {
    for (const rel of this.packIndexPathCandidates(worldId, safePackId)) {
      if (await this.exists(rel)) return this.readJson(rel);
    }
    return null;
  }

  /* -------------------------------------------- */
  /* VaultSync meta (your new working layout)     */
  /* -------------------------------------------- */

  vaultSyncRoot(worldId: WorldId) {
    return `${this.worldRoot(worldId)}/vaultsync`;
  }

  metaDir(worldId: WorldId) {
    return `${this.vaultSyncRoot(worldId)}/meta`;
  }

  /**
   * Parse filenames like:
   *   status.1772603880617.7eyq2x.json
   * base.ts.suffix.json  -> returns ts
   */
  private parseVersionedTs(name: string, base: string): number | null {
    if (!name.startsWith(base + ".")) return null;
    if (!name.endsWith(".json")) return null;

    const parts = name.split(".");
    // e.g. ["status","1772603880617","7eyq2x","json"]
    if (parts.length < 4) return null;

    const ts = Number(parts[1]);
    return Number.isFinite(ts) ? ts : null;
  }

  private async listFilesSafe(rel: string): Promise<string[]> {
    try {
      return await this.listFiles(rel);
    } catch {
      return [];
    }
  }

  private async readLatestVersionedJsonInDir<T = any>(
    dirRel: string,
    baseName: string
  ): Promise<T | null> {
    const files = await this.listFilesSafe(dirRel);

    let bestFile: string | null = null;
    let bestTs = -1;

    for (const f of files) {
      const ts = this.parseVersionedTs(f, baseName);
      if (ts == null) continue;
      if (ts > bestTs) {
        bestTs = ts;
        bestFile = f;
      }
    }

    if (!bestFile) return null;

    try {
      return await this.readJson<T>(`${dirRel}/${bestFile}`);
    } catch {
      return null;
    }
  }

  /**
   * Back-compat: try versioned latest first, then fall back to single file:
   *   <meta>/<base>.<ts>.<suffix>.json
   *   <meta>/<base>.json
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

  /** ✅ what your worlds router is calling */
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

  /* -------------------------------------------- */
  /* Worlds listing                               */
  /* -------------------------------------------- */

  async listWorldIds(): Promise<string[]> {
    const base = "worlds";
    if (!(await this.exists(base))) return [];
    return (await this.listDirs(base)).sort();
  }
}