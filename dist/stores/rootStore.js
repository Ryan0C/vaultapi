// stores/rootStore.ts
import path from "node:path";
import fs from "node:fs/promises";
export class RootStore {
    dataRootAbs;
    constructor(dataRootAbs) {
        this.dataRootAbs = dataRootAbs;
    }
    /** Join and ensure the result stays within dataRootAbs. */
    abs(rel) {
        const cleaned = String(rel ?? "").replace(/^\/+/, "");
        const out = path.resolve(this.dataRootAbs, cleaned);
        const root = path.resolve(this.dataRootAbs);
        if (!out.startsWith(root + path.sep) && out !== root) {
            throw new Error(`path escapes root: ${rel}`);
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
    async readText(rel) {
        return fs.readFile(this.abs(rel), "utf-8");
    }
    async readJson(rel) {
        return JSON.parse(await this.readText(rel));
    }
    async writeText(rel, text) {
        const file = this.abs(rel);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, text, "utf-8");
    }
    async writeJson(rel, data) {
        await this.writeText(rel, JSON.stringify(data, null, 2));
    }
    async deleteFile(rel) {
        try {
            await fs.unlink(this.abs(rel));
        }
        catch { }
    }
    async listDirs(rel) {
        const entries = await fs.readdir(this.abs(rel), { withFileTypes: true });
        return entries.filter(e => e.isDirectory()).map(e => e.name);
    }
    async listFiles(rel) {
        const entries = await fs.readdir(this.abs(rel), { withFileTypes: true });
        return entries.filter(e => e.isFile()).map(e => e.name);
    }
    async listFilesSafe(rel) {
        try {
            return await this.listFiles(rel);
        }
        catch {
            return [];
        }
    }
}
//# sourceMappingURL=rootStore.js.map