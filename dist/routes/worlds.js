// src/routes/world.ts
import { Router } from "express";
function isENOENT(err) {
    const msg = String(err?.message ?? err).toLowerCase();
    return msg.includes("enoent") || msg.includes("no such file");
}
export function makeWorldsRouter(deps) {
    const router = Router();
    const { worldStore } = deps;
    /**
     * GET /worlds
     * List available worlds
     */
    router.get("/", async (_req, res, next) => {
        try {
            const worldIds = await worldStore.listWorldIds();
            const now = Date.now();
            const ttlMs = 60_000;
            const worlds = await Promise.all(worldIds.map(async (id) => {
                const [meta, status] = await Promise.all([
                    worldStore.readWorldMeta(id).catch(() => null),
                    worldStore.readStatusMeta(id).catch(() => null),
                ]);
                const last = Date.parse(status?.lastHeartbeatAt ?? "");
                const ageMs = Number.isFinite(last) ? now - last : Infinity;
                const online = ageMs >= 0 && ageMs < ttlMs;
                return { id, meta, online };
            }));
            res.json({ ok: true, worlds });
        }
        catch (err) {
            next(err);
        }
    });
    /**
     * GET /worlds/:worldId/meta
     */
    router.get("/:worldId/meta", async (req, res, next) => {
        try {
            const { worldId } = req.params;
            const world = await worldStore.readWorldMeta(worldId);
            const users = await worldStore.readUsersMeta(worldId);
            const status = await worldStore.readStatusMeta(worldId);
            const vaultMeta = await worldStore.readVaultMeta(worldId);
            res.json({ ok: true, worldId, world, users, status, vault: vaultMeta });
        }
        catch (err) {
            if (isENOENT(err)) {
                return res.status(404).json({ ok: false, error: "world meta not found" });
            }
            next(err);
        }
    });
    /**
     * GET /worlds/:worldId/status
     */
    router.get("/:worldId/status", async (req, res, next) => {
        try {
            const { worldId } = req.params;
            // Prevent 304 / caching (important for polling + UI gating)
            res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
            res.setHeader("Pragma", "no-cache");
            res.setHeader("Expires", "0");
            res.removeHeader("ETag");
            // If the world itself doesn't exist, 404
            try {
                const world = await worldStore.readWorldMeta(worldId);
                if (!world)
                    return res.status(404).json({ ok: false, error: "world meta not found" });
            }
            catch (e) {
                if (isENOENT(e))
                    return res.status(404).json({ ok: false, error: "world meta not found" });
                throw e;
            }
            // May be null if not written yet
            const status = await worldStore.readStatusMeta(worldId).catch(() => null);
            const ttlMs = 60_000;
            const rawLast = status?.lastHeartbeatAt ??
                status?.lastHeartbeat ??
                status?.status?.lastHeartbeatAt ??
                status?.status?.lastHeartbeat ??
                null;
            const lastMs = typeof rawLast === "number"
                ? rawLast
                : typeof rawLast === "string"
                    ? Date.parse(rawLast)
                    : NaN;
            const nowMs = Date.now();
            const ageMs = Number.isFinite(lastMs) ? nowMs - lastMs : null;
            let state = "missing";
            let online = false;
            if (!status) {
                state = "missing";
                online = false;
            }
            else if (!Number.isFinite(lastMs)) {
                state = "stale";
                online = false;
            }
            else if ((ageMs ?? 0) < -1000) {
                state = "clock_skew";
                online = true;
            }
            else if ((ageMs ?? Infinity) < ttlMs) {
                state = "online";
                online = true;
            }
            else {
                state = "stale";
                online = false;
            }
            const startedAt = status?.startedAt ?? status?.status?.startedAt ?? null;
            const isReady = typeof status?.isReady === "boolean"
                ? status.isReady
                : typeof status?.status?.isReady === "boolean"
                    ? status.status.isReady
                    : null;
            const activeUsers = typeof status?.activeUsers === "number"
                ? status.activeUsers
                : typeof status?.status?.activeUsers === "number"
                    ? status.status.activeUsers
                    : null;
            const userCount = typeof status?.userCount === "number"
                ? status.userCount
                : typeof status?.status?.userCount === "number"
                    ? status.status.userCount
                    : null;
            return res.json({
                ok: true,
                worldId,
                online,
                state,
                ttlMs,
                checkedAt: new Date(nowMs).toISOString(),
                lastHeartbeatAt: Number.isFinite(lastMs) ? new Date(lastMs).toISOString() : null,
                ageMs,
                startedAt,
                isReady,
                activeUsers,
                userCount,
                status: status ?? null,
            });
        }
        catch (err) {
            next(err);
        }
    });
    return router;
}
//# sourceMappingURL=worlds.js.map