import { Router } from "express";
import type { CreateAppDeps } from "../app.js";
import { makeRequireWorldMember } from "../middleware/authz.js";
import { forbidden, unauthorized } from "../utils/errors.js";

function getVaultUserId(req: any): string | null {
  // API key superuser bypass means "act as system"
  if (req.auth?.kind === "apiKey" && req.auth?.superuser) return null;
  return req.session?.userId ?? null;
}

function isApiKeySuperuser(req: any): boolean {
  return req.auth?.kind === "apiKey" && !!req.auth?.superuser;
}

function asParamString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return String(value[0] ?? "").trim();
  return String(value ?? "").trim();
}

function unwrapActorSnapshot(actor: any, actorIdHint?: string): any {
  if (!actor || typeof actor !== "object") return actor;
  const unwrapped =
    (actor.foundry && typeof actor.foundry === "object" ? actor.foundry : null) ??
    (actor.data && typeof actor.data === "object" ? actor.data : null) ??
    actor;

  if (!unwrapped || typeof unwrapped !== "object") return unwrapped;
  const out = { ...(unwrapped as Record<string, unknown>) } as any;
  if (!out.id && typeof out._id === "string") out.id = out._id;
  if (!out._id && typeof out.id === "string") out._id = out.id;
  if (!out.id && actorIdHint) out.id = actorIdHint;
  if (!out._id && actorIdHint) out._id = actorIdHint;
  return out;
}

// Minimal shape the router needs from the new store
type ActorsStore = {
  readActorsManifest(worldId: string): Promise<any | null>;
  listActorIds(worldId: string): Promise<string[]>;
  readActorTombstone(worldId: string, actorId: string): Promise<any | null>;
  readActor(worldId: string, actorId: string): Promise<any | null>;
};

export function makeActorsRouter(deps: CreateAppDeps) {
  const router = Router();

  const { authStore, actorsStore } = deps as unknown as CreateAppDeps & {
    actorsStore: ActorsStore;
  };

  const requireWorldMember = makeRequireWorldMember(authStore);

  /**
   * GET /worlds/:worldId/actors
   * - DM/superadmin => all actors
   * - player/observer => only assigned actors (world_actor_links)
   */
  router.get("/:worldId/actors", requireWorldMember, async (req, res, next) => {
    try {
      const worldId = asParamString(req.params.worldId);
      const anyReq = req as any;

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
      if (!userId) return next(unauthorized("Login required"));

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
      if (isDm) return res.json(manifest);

      // player/observer: filter manifest actors by assignment
      const links = authStore.listActorsForUserInWorld(worldId, userId);
      const allowed = new Set(links.map((l) => l.actorId));

      const actors = Array.isArray((manifest as any).actors) ? (manifest as any).actors : [];
      const filteredActors = actors.filter((a: any) => allowed.has(String(a?.id ?? "")));

      return res.json({
        ...(manifest as any),
        actors: filteredActors,
        count: filteredActors.length,
        note: "filtered by actor assignments",
      });
    } catch (err) {
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
      const anyReq = req as any;

      const userId = isApiKeySuperuser(anyReq) ? null : getVaultUserId(anyReq);
      if (!isApiKeySuperuser(anyReq) && !userId) {
        return next(unauthorized("Login required"));
      }

      const manifest = await actorsStore.readActorsManifest(worldId);
      if (!manifest) {
        return res.json({ ok: true, worldId, since, count: 0, actors: [] });
      }

      /** Coerce exportedAt/updatedAt (ISO string or epoch ms) to epoch ms. */
      const toEpoch = (val: unknown): number => {
        if (!val) return 0;
        if (typeof val === "number") return val;
        const d = new Date(val as string);
        return isNaN(d.getTime()) ? 0 : d.getTime();
      };

      const allActors: any[] = Array.isArray((manifest as any).actors)
        ? (manifest as any).actors
        : [];

      // Filter to actors that have been exported/updated after `since`
      let changed = allActors.filter((a: any) => {
        const ts = toEpoch(a.exportedAt) || toEpoch(a.updatedAt);
        return ts > since;
      });

      // Non-DM users only see their assigned actors
      if (userId && !authStore.isWorldDm(worldId, userId)) {
        const links = authStore.listActorsForUserInWorld(worldId, userId);
        const allowed = new Set(links.map((l) => l.actorId));
        changed = changed.filter((a: any) => allowed.has(String(a?.id ?? "")));
      }

      return res.json({ ok: true, worldId, since, count: changed.length, actors: changed });
    } catch (err) {
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
      const anyReq = req as any;

      // API key superuser => allowed
      if (!isApiKeySuperuser(anyReq)) {
        const userId = getVaultUserId(anyReq);
        if (!userId) return next(unauthorized("Login required"));

        const ok = authStore.canAccessActor({ worldId, actorId, vaultUserId: userId });
        if (!ok) return next(forbidden("Actor access denied"));
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

      return res.json({ ok: true, actor: unwrapActorSnapshot(actor, actorId) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
