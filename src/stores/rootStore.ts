// stores/rootStore.ts
import path from "node:path";
import fs from "node:fs/promises";

export class RootStore {
  constructor(private dataRootAbs: string) {}

  /** Join and ensure the result stays within dataRootAbs. */
  protected abs(rel: string): string {
    const cleaned = String(rel ?? "").replace(/^\/+/, "");
    const out = path.resolve(this.dataRootAbs, cleaned);
    const root = path.resolve(this.dataRootAbs);
    if (!out.startsWith(root + path.sep) && out !== root) {
      throw new Error(`path escapes root: ${rel}`);
    }
    return out;
  }

  async exists(rel: string): Promise<boolean> {
    try { await fs.access(this.abs(rel)); return true; } catch { return false; }
  }

  async readText(rel: string): Promise<string> {
    return fs.readFile(this.abs(rel), "utf-8");
  }

  async readJson<T = any>(rel: string): Promise<T> {
    return JSON.parse(await this.readText(rel)) as T;
  }

  async writeText(rel: string, text: string): Promise<void> {
    const file = this.abs(rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, "utf-8");
  }

  async writeJson(rel: string, data: unknown): Promise<void> {
    await this.writeText(rel, JSON.stringify(data, null, 2));
  }

  async deleteFile(rel: string): Promise<void> {
    try { await fs.unlink(this.abs(rel)); } catch {}
  }

  async listDirs(rel: string): Promise<string[]> {
    const entries = await fs.readdir(this.abs(rel), { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  }

  async listFiles(rel: string): Promise<string[]> {
    const entries = await fs.readdir(this.abs(rel), { withFileTypes: true });
    return entries.filter(e => e.isFile()).map(e => e.name);
  }

  protected async listFilesSafe(rel: string): Promise<string[]> {
    try { return await this.listFiles(rel); } catch { return []; }
  }
}