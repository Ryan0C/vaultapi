// src/routes/health.ts
import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";
async function canAccessDir(dir) {
    try {
        const st = await fs.stat(dir);
        if (!st.isDirectory())
            return false;
        await fs.access(dir);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Health router is dependency-injected so tests don't rely on module-load globals.
 */
export function makeHealthRouter(deps) {
    const router = Router();
    /**
     * GET /health
     * Lightweight health check:
     * - confirms VAULT_ROOT exists + readable
     * - returns worldCount/worlds if possible
     *
     * Notes:
     * - This endpoint is typically excluded from auth.
     * - Returning 200 with vaultRootAccessible=false is also defensible,
     *   but keeping 500 here is fine if you want probes to fail hard.
     */
    router.get("/", async (_req, res) => {
        const started = Date.now();
        const vaultRoot = deps.vaultRoot;
        const vaultRootAccessible = await canAccessDir(vaultRoot);
        if (!vaultRootAccessible) {
            return res.status(500).json({
                ok: false,
                service: "vault-api",
                vaultRoot,
                vaultRootAccessible: false,
                worldCount: 0,
                worlds: [],
                durationMs: Date.now() - started
            });
        }
        try {
            const worldIds = await deps.vault.listWorldIds();
            return res.json({
                ok: true,
                service: "vault-api",
                vaultRoot,
                vaultRootAccessible: true,
                worldCount: worldIds.length,
                worlds: worldIds,
                durationMs: Date.now() - started
            });
        }
        catch (err) {
            // Root is accessible but listing failed => probably permissions or malformed tree
            return res.status(500).json({
                ok: false,
                service: "vault-api",
                vaultRoot,
                vaultRootAccessible: true,
                error: String(err?.message ?? err),
                durationMs: Date.now() - started
            });
        }
    });
    /**
     * GET /health/deep
     * Deeper probe:
     * - confirms VAULT_ROOT readable
     * - confirms "worlds" directory exists/readable
     * - attempts reading meta/world.json for first world (if any)
     *
     * Keep response small and stable for probes.
     */
    router.get("/deep", async (_req, res) => {
        const started = Date.now();
        const vaultRoot = deps.vaultRoot;
        const worldsDir = path.join(vaultRoot, "worlds"); // ✅ matches VaultStore.worldRoot()
        try {
            const vaultRootAccessible = await canAccessDir(vaultRoot);
            const worldsDirAccessible = await canAccessDir(worldsDir);
            let worldIds = [];
            let sampleWorldId = null;
            let sampleWorldMetaOk = false;
            if (vaultRootAccessible) {
                worldIds = await deps.vault.listWorldIds();
                sampleWorldId = worldIds[0] ?? null;
            }
            if (sampleWorldId) {
                const meta = await deps.vault.readWorldMeta(sampleWorldId).catch(() => null);
                sampleWorldMetaOk = !!meta;
            }
            const ok = vaultRootAccessible && worldsDirAccessible;
            return res.status(ok ? 200 : 500).json({
                ok,
                service: "vault-api",
                vaultRoot,
                vaultRootAccessible,
                worldsDir,
                worldsDirAccessible,
                worldCount: worldIds.length,
                sampleWorldId,
                sampleWorldMetaOk,
                durationMs: Date.now() - started
            });
        }
        catch (err) {
            return res.status(500).json({
                ok: false,
                service: "vault-api",
                vaultRoot: deps.vaultRoot,
                error: String(err?.message ?? err),
                durationMs: Date.now() - started
            });
        }
    });
    return router;
}
//# sourceMappingURL=health.js.map