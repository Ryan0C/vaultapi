import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { ActorsStore } from "../stores/actorsStore.js";
function normalizeRel(p) {
    return String(p ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
}
async function listWorldIds(foundryDataRoot) {
    const worldsDir = path.join(foundryDataRoot, "worlds");
    const entries = await fs.readdir(worldsDir, { withFileTypes: true }).catch(() => []);
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}
async function listAvatarCandidates(foundryDataRoot, worldId) {
    const relDir = path.join("worlds", worldId, "vaulthero", "uploads", "avatar");
    const absDir = path.join(foundryDataRoot, relDir);
    const entries = await fs.readdir(absDir, { withFileTypes: true }).catch(() => []);
    const out = [];
    for (const entry of entries) {
        if (!entry.isFile())
            continue;
        const relPath = normalizeRel(path.join(relDir, entry.name));
        const absPath = path.join(absDir, entry.name);
        const stat = await fs.stat(absPath).catch(() => null);
        out.push({
            worldId,
            relPath,
            absPath,
            size: Number(stat?.size ?? 0),
        });
    }
    return out;
}
function extractActorImage(record) {
    const foundry = record?.foundry ?? record?.data ?? record;
    return normalizeRel(String(foundry?.img ?? ""));
}
async function collectReferencedAvatarPaths(foundryDataRoot) {
    const actorsStore = new ActorsStore({ dataRoot: foundryDataRoot });
    const referenced = new Set();
    const worldIds = await listWorldIds(foundryDataRoot);
    for (const worldId of worldIds) {
        const actorIds = await actorsStore.listActorIds(worldId).catch(() => []);
        for (const actorId of actorIds) {
            const record = await actorsStore.readActor(worldId, actorId).catch(() => null);
            if (!record)
                continue;
            const img = extractActorImage(record);
            if (!img)
                continue;
            if (!img.startsWith(`worlds/${worldId}/vaulthero/uploads/avatar/`))
                continue;
            referenced.add(img);
        }
    }
    return referenced;
}
function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0)
        return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let idx = 0;
    while (value >= 1024 && idx < units.length - 1) {
        value /= 1024;
        idx += 1;
    }
    return `${value.toFixed(value >= 10 || idx === 0 ? 0 : 1)} ${units[idx]}`;
}
async function main() {
    const apply = process.argv.includes("--apply");
    const foundryDataRoot = config.foundryDataRoot;
    if (!foundryDataRoot) {
        throw new Error("FOUNDRY_DATA_ROOT is not configured.");
    }
    const referenced = await collectReferencedAvatarPaths(foundryDataRoot);
    const worldIds = await listWorldIds(foundryDataRoot);
    const allCandidates = (await Promise.all(worldIds.map((worldId) => listAvatarCandidates(foundryDataRoot, worldId)))).flat();
    const stale = allCandidates.filter((file) => !referenced.has(file.relPath));
    const totalBytes = stale.reduce((sum, file) => sum + file.size, 0);
    console.log(`[cleanupAvatarUploads] mode=${apply ? "apply" : "dry-run"}`);
    console.log(`[cleanupAvatarUploads] foundryDataRoot=${foundryDataRoot}`);
    console.log(`[cleanupAvatarUploads] avatarFiles=${allCandidates.length} referenced=${referenced.size} stale=${stale.length} reclaimable=${formatBytes(totalBytes)}`);
    if (!stale.length) {
        console.log("[cleanupAvatarUploads] no stale avatar uploads found");
        return;
    }
    for (const file of stale) {
        console.log(` - ${file.relPath} (${formatBytes(file.size)})`);
    }
    if (!apply) {
        console.log("[cleanupAvatarUploads] dry run only. Re-run with --apply to delete these files.");
        return;
    }
    for (const file of stale) {
        await fs.rm(file.absPath, { force: true });
    }
    console.log(`[cleanupAvatarUploads] deleted=${stale.length} reclaimed=${formatBytes(totalBytes)}`);
}
main().catch((err) => {
    console.error("[cleanupAvatarUploads] failed", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
});
//# sourceMappingURL=cleanupAvatarUploads.js.map