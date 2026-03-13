import { Router } from "express";
import { makeRequireWorldMember } from "../middleware/authz.js";
import { forbidden, unauthorized } from "../utils/errors.js";
import { asParamString, isCharacterSnapshot, summarizePartyActor, unwrapActorSnapshot, } from "./actorSummary.js";
function getVaultUserId(req) {
    // API key superuser bypass means "act as system"
    if (req.auth?.kind === "apiKey" && req.auth?.superuser)
        return null;
    return req.session?.userId ?? null;
}
function isApiKeySuperuser(req) {
    return req.auth?.kind === "apiKey" && !!req.auth?.superuser;
}
export function makeActorsRouter(deps) {
    const router = Router();
    const { authStore, actorsStore } = deps;
    const requireWorldMember = makeRequireWorldMember(authStore);
    /**
     * GET /worlds/:worldId/actors
     * - DM/superadmin => all actors
     * - player/observer => only assigned actors (world_actor_links)
     */
    router.get("/:worldId/actors", requireWorldMember, async (req, res, next) => {
        try {
            const worldId = asParamString(req.params.worldId);
            const anyReq = req;
            // API key superuser => show everything
            if (isApiKeySuperuser(anyReq)) {
                const manifest = await actorsStore.readActorsManifest(worldId);
                if (!manifest) {
                    const actorIds = await actorsStore.listActorIds(worldId);
                    return res.json({
                        worldId,
                        count: actorIds.length,
                        actors: actorIds.map((id) => ({ id })),
                        generatedAt: new Date().toISOString(),
                        note: "manifest missing; returned file-based listing",
                    });
                }
                return res.json(manifest);
            }
            const userId = getVaultUserId(anyReq);
            if (!userId)
                return next(unauthorized("Login required"));
            // DM can see all
            const isDm = authStore.isWorldDm(worldId, userId);
            const manifest = await actorsStore.readActorsManifest(worldId);
            // If manifest missing, fall back to directory listing.
            if (!manifest) {
                const actorIds = await actorsStore.listActorIds(worldId);
                if (isDm) {
                    return res.json({
                        worldId,
                        count: actorIds.length,
                        actors: actorIds.map((id) => ({ id })),
                        generatedAt: new Date().toISOString(),
                        note: "manifest missing; returned file-based listing",
                    });
                }
                // player/observer: only assigned actors
                const links = authStore.listActorsForUserInWorld(worldId, userId);
                const allowed = new Set(links.map((l) => l.actorId));
                const filteredIds = actorIds.filter((id) => allowed.has(id));
                return res.json({
                    worldId,
                    count: filteredIds.length,
                    actors: filteredIds.map((id) => ({ id })),
                    generatedAt: new Date().toISOString(),
                    note: "manifest missing; filtered by actor assignments",
                });
            }
            // Manifest exists
            if (isDm)
                return res.json(manifest);
            // player/observer: filter manifest actors by assignment
            const links = authStore.listActorsForUserInWorld(worldId, userId);
            const allowed = new Set(links.map((l) => l.actorId));
            const actors = Array.isArray(manifest.actors) ? manifest.actors : [];
            const filteredActors = actors.filter((a) => allowed.has(String(a?.id ?? "")) && String(a?.type ?? "").toLowerCase() === "character");
            return res.json({
                ...manifest,
                actors: filteredActors,
                count: filteredActors.length,
                note: "filtered by actor assignments",
            });
        }
        catch (err) {
            next(err);
        }
    });
    /**
     * GET /worlds/:worldId/actors/changes?since=<epochMs>
     *
     * Returns actors whose exportedAt timestamp is greater than `since`.
     * Vaulthero calls this to detect Foundry-side actor updates without
     * re-fetching every actor on every poll.
     *
     * IMPORTANT: must be registered BEFORE /:worldId/actors/:actorId so
     * Express does not match "changes" as the :actorId path parameter.
     */
    router.get("/:worldId/actors/changes", requireWorldMember, async (req, res, next) => {
        try {
            const worldId = asParamString(req.params.worldId);
            const since = Number(req.query.since ?? 0) || 0;
            const anyReq = req;
            const userId = isApiKeySuperuser(anyReq) ? null : getVaultUserId(anyReq);
            if (!isApiKeySuperuser(anyReq) && !userId) {
                return next(unauthorized("Login required"));
            }
            const manifest = await actorsStore.readActorsManifest(worldId);
            if (!manifest) {
                return res.json({ ok: true, worldId, since, count: 0, actors: [] });
            }
            /** Coerce exportedAt/updatedAt (ISO string or epoch ms) to epoch ms. */
            const toEpoch = (val) => {
                if (!val)
                    return 0;
                if (typeof val === "number")
                    return val;
                const d = new Date(val);
                return isNaN(d.getTime()) ? 0 : d.getTime();
            };
            const allActors = Array.isArray(manifest.actors)
                ? manifest.actors
                : [];
            // Filter to actors that have been exported/updated after `since`
            let changed = allActors.filter((a) => {
                const ts = toEpoch(a.exportedAt) || toEpoch(a.updatedAt);
                return ts > since;
            });
            // Non-DM users only see their assigned actors
            if (userId && !authStore.isWorldDm(worldId, userId)) {
                const links = authStore.listActorsForUserInWorld(worldId, userId);
                const allowed = new Set(links.map((l) => l.actorId));
                changed = changed.filter((a) => allowed.has(String(a?.id ?? "")) && String(a?.type ?? "").toLowerCase() === "character");
            }
            return res.json({ ok: true, worldId, since, count: changed.length, actors: changed });
        }
        catch (err) {
            next(err);
        }
    });
    router.get("/:worldId/party", requireWorldMember, async (req, res, next) => {
        try {
            const worldId = asParamString(req.params.worldId);
            const requesterUserId = getVaultUserId(req);
            const manifest = await actorsStore.readActorsManifest(worldId);
            const manifestActors = Array.isArray(manifest?.actors) ? manifest.actors : [];
            const actorIds = manifestActors.length
                ? manifestActors.map((actor) => String(actor?.id ?? actor?._id ?? "").trim()).filter(Boolean)
                : await actorsStore.listActorIds(worldId);
            const summaries = await Promise.all(Array.from(new Set(actorIds)).map(async (actorId) => {
                const actor = await actorsStore.readActor(worldId, actorId);
                return summarizePartyActor(actor, worldId, authStore, requesterUserId);
            }));
            return res.json({
                ok: true,
                worldId,
                party: summaries.filter(Boolean),
            });
        }
        catch (err) {
            next(err);
        }
    });
    /**
     * GET /worlds/:worldId/actors/:actorId
     * - DM/superadmin => allowed
     * - player/observer => must be assigned to actor
     */
    router.get("/:worldId/actors/:actorId", requireWorldMember, async (req, res, next) => {
        try {
            const worldId = asParamString(req.params.worldId);
            const actorId = asParamString(req.params.actorId);
            const anyReq = req;
            // API key superuser => allowed
            if (!isApiKeySuperuser(anyReq)) {
                const userId = getVaultUserId(anyReq);
                if (!userId)
                    return next(unauthorized("Login required"));
                const ok = authStore.canAccessActor({ worldId, actorId, vaultUserId: userId });
                if (!ok)
                    return next(forbidden("Actor access denied"));
            }
            // Tombstone => 410 Gone
            const tombstone = await actorsStore.readActorTombstone(worldId, actorId);
            if (tombstone) {
                return res.status(410).json({
                    ok: false,
                    deleted: true,
                    tombstone,
                });
            }
            const actor = await actorsStore.readActor(worldId, actorId);
            if (!actor) {
                return res.status(404).json({ ok: false, error: "Actor not found" });
            }
            if (!isApiKeySuperuser(anyReq)) {
                const userId = getVaultUserId(anyReq);
                if (userId && !authStore.isWorldDm(worldId, userId) && !isCharacterSnapshot(actor)) {
                    return next(forbidden("Actor access denied"));
                }
            }
            return res.json({ ok: true, actor: unwrapActorSnapshot(actor, actorId) });
        }
        catch (err) {
            next(err);
        }
    });
    return router;
}
//# sourceMappingURL=actors.js.map