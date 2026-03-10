// @ts-nocheck
// src/routes/packs.ts
import { Router } from "express";
import { makeRequireWorldMember } from "../middleware/authz.js";
function firstQueryValue(v) {
    if (Array.isArray(v))
        return String(v[0] ?? "");
    return String(v ?? "");
}
function optionalString(v) {
    const s = firstQueryValue(v).trim();
    return s ? s : undefined;
}
function optionalNumber(v) {
    const raw = firstQueryValue(v).trim();
    if (!raw)
        return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
}
export function makePacksRouter(deps) {
    const router = Router();
    const { authStore } = deps;
    const { itemsPacksStore } = deps;
    const requireWorldMember = makeRequireWorldMember(authStore);
    /**
     * GET /worlds/:worldId/packs
     */
    router.get("/:worldId/packs", requireWorldMember, async (req, res, next) => {
        try {
            const { worldId } = req.params;
            deps.logger.info("packs.list", { worldId });
            const packIds = await itemsPacksStore.listPackIds(worldId);
            const metas = await Promise.all(packIds.map((id) => itemsPacksStore.getPackMeta(worldId, id)));
            const packs = metas
                .filter(Boolean)
                .sort((a, b) => String(a.id).localeCompare(String(b.id)));
            // Safe for authenticated endpoints: keep cache private to the user agent.
            res.setHeader("Cache-Control", "private, max-age=30, stale-while-revalidate=30");
            return res.json({
                ok: true,
                worldId,
                count: packs.length,
                packs,
            });
        }
        catch (err) {
            next(err);
        }
    });
    /**
     * GET /worlds/:worldId/packs/:packId/index
     */
    router.get("/:worldId/packs/:packId/index", requireWorldMember, async (req, res, next) => {
        try {
            const { worldId, packId } = req.params;
            const idx = await itemsPacksStore.readLatestPackIndex(worldId, packId);
            if (!idx) {
                return res.status(404).json({ ok: false, error: "Pack index not found" });
            }
            res.setHeader("Cache-Control", "private, max-age=30, stale-while-revalidate=30");
            return res.json({ ok: true, worldId, packId, index: idx });
        }
        catch (err) {
            next(err);
        }
    });
    /**
     * GET /worlds/:worldId/packs/:packId/search?q=...&limit=...&type=...&level=...&cls=...&subclass=...
     */
    router.get("/:worldId/packs/:packId/search", requireWorldMember, async (req, res, next) => {
        try {
            const { worldId, packId } = req.params;
            const q = String(req.query?.q ?? "");
            const limit = Number(req.query?.limit ?? 50);
            const cls = String(req.query?.cls ?? "").trim() || undefined;
            const subclass = String(req.query?.subclass ?? "").trim() || undefined;
            const school = String(req.query?.school ?? "").trim() || undefined;
            const type = String(req.query?.type ?? "").trim() || undefined;
            const levelRaw = req.query?.level;
            const level = levelRaw == null || levelRaw === ""
                ? undefined
                : Number(levelRaw);
            const concentrationRaw = String(req.query?.concentration ?? "").trim();
            const concentration = concentrationRaw === "true" ? true :
                concentrationRaw === "false" ? false :
                    undefined;
            const ritualRaw = String(req.query?.ritual ?? "").trim();
            const ritual = ritualRaw === "true" ? true :
                ritualRaw === "false" ? false :
                    undefined;
            const hasAnyCriteria = !!q.trim() ||
                !!cls ||
                !!subclass ||
                !!school ||
                !!type ||
                level != null ||
                concentration != null ||
                ritual != null;
            if (!hasAnyCriteria) {
                return res.status(400).json({ ok: false, error: "Provide q or at least one filter" });
            }
            const hits = await itemsPacksStore.searchPackEntries({
                worldId,
                packId,
                q,
                limit,
                cls,
                subclass,
                school,
                type,
                level,
                concentration,
                ritual,
            });
            res.setHeader("Cache-Control", "private, max-age=15, stale-while-revalidate=30");
            return res.json({
                ok: true,
                worldId,
                packId,
                q: q ?? "",
                filters: {
                    type: type ?? null,
                    level: level ?? null,
                    cls: cls ?? null,
                    subclass: subclass ?? null,
                },
                count: hits.length,
                hits,
            });
        }
        catch (err) {
            next(err);
        }
    });
    return router;
}
//# sourceMappingURL=packs.js.map