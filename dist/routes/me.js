// src/routes/me.ts
import { Router } from "express";
import { makeRequireUser } from "../middleware/authz.js";
function deriveWorldStatus(status, ttlMs = 10_000) {
    const nowMs = Date.now();
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
    return {
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
    };
}
export function makeMeRouter(deps) {
    const router = Router();
    const requireUser = makeRequireUser();
    const { authStore, worldStore } = deps;
    router.get("/worlds", requireUser, async (req, res, next) => {
        try {
            // prevent caching/304
            res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
            res.setHeader("Pragma", "no-cache");
            res.setHeader("Expires", "0");
            res.removeHeader("ETag");
            const anyReq = req;
            const sessionUserId = anyReq.session?.userId;
            const ttlMs = 10_000;
            // Superadmin: all worlds
            if (sessionUserId) {
                const user = authStore.getUserById(sessionUserId);
                if (user?.is_superadmin) {
                    const worldIds = await worldStore.listWorldIds();
                    const worlds = await Promise.all(worldIds.map(async (id) => {
                        const [meta, rawStatus] = await Promise.all([
                            worldStore.readWorldMeta(id).catch(() => null),
                            worldStore.readStatusMeta(id).catch(() => null),
                        ]);
                        return {
                            id,
                            meta,
                            status: deriveWorldStatus(rawStatus, ttlMs),
                        };
                    }));
                    return res.json({ ok: true, worlds, superuser: true });
                }
            }
            // Normal user: linked worlds only
            const userId = sessionUserId ?? null;
            if (!userId) {
                return res.json({ ok: true, worlds: [] });
            }
            const links = authStore.listUserWorldLinks(userId);
            const worlds = await Promise.all(links.map(async (l) => {
                const [meta, rawStatus] = await Promise.all([
                    worldStore.readWorldMeta(l.worldId).catch(() => null),
                    worldStore.readStatusMeta(l.worldId).catch(() => null),
                ]);
                return {
                    id: l.worldId,
                    foundryUserId: l.foundryUserId,
                    meta,
                    status: deriveWorldStatus(rawStatus, ttlMs),
                };
            }));
            return res.json({ ok: true, worlds });
        }
        catch (err) {
            next(err);
        }
    });
    return router;
}
//# sourceMappingURL=me.js.map