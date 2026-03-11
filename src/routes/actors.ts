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

function readNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function resolveItemName(raw: any, items: any[], types: string[]): string {
  if (!raw) return "";
  const normalizedTypes = new Set(types.map((t) => String(t).toLowerCase()));
  const actorItems = Array.isArray(items) ? items : [];

  if (typeof raw === "string") {
    const byId = actorItems.find((it: any) =>
      normalizedTypes.has(String(it?.type ?? "").toLowerCase()) &&
      String(it?._id ?? it?.id ?? "").trim() === raw
    );
    if (byId?.name) return String(byId.name).trim();
    return raw.trim();
  }

  const embeddedId = String(raw?._id ?? raw?.id ?? "").trim();
  if (embeddedId) {
    const byId = actorItems.find((it: any) =>
      normalizedTypes.has(String(it?.type ?? "").toLowerCase()) &&
      String(it?._id ?? it?.id ?? "").trim() === embeddedId
    );
    if (byId?.name) return String(byId.name).trim();
  }

  return String(raw?.name ?? raw?.label ?? raw?.value ?? "").trim();
}

function actorLevel(actor: any): number | null {
  const direct = readNumber(actor?.system?.details?.level);
  if (direct != null) return Math.max(0, Math.trunc(direct));

  const classItems = (Array.isArray(actor?.items) ? actor.items : []).filter(
    (it: any) => String(it?.type ?? "").toLowerCase() === "class"
  );
  if (!classItems.length) return null;

  let total = 0;
  for (const item of classItems) {
    const level = readNumber(item?.system?.levels ?? item?.system?.level ?? 0) ?? 0;
    total += Math.max(0, Math.trunc(level));
  }
  return total > 0 ? total : null;
}

function actorSpecies(actor: any): string {
  const items = Array.isArray(actor?.items) ? actor.items : [];
  const raw = actor?.system?.details?.species ?? actor?.system?.details?.race ?? "";
  return resolveItemName(raw, items, ["species", "race"]);
}

function actorClass(actor: any): string {
  const direct = String(actor?.system?.details?.class ?? "").trim();
  if (direct) return direct;

  const names = (Array.isArray(actor?.items) ? actor.items : [])
    .filter((it: any) => String(it?.type ?? "").toLowerCase() === "class")
    .map((it: any) => String(it?.name ?? "").trim())
    .filter(Boolean);
  return names.join(" / ");
}

function actorImage(actor: any): string {
  return String(
    actor?.img ??
    actor?.prototypeToken?.texture?.src ??
    actor?.prototypeToken?.src ??
    ""
  ).trim();
}

function actorLocation(actor: any): string {
  return String(actor?.flags?.vaulthero?.location ?? "").trim();
}

function actorDeceased(actor: any): boolean {
  const hpVal = readNumber(actor?.system?.attributes?.hp?.value);
  const hpMax = readNumber(actor?.system?.attributes?.hp?.max);
  if (hpVal != null && hpMax != null && hpMax > 0 && hpVal <= 0) return true;

  const effects = Array.isArray(actor?.effects) ? actor.effects : [];
  return effects.some((effect: any) => {
    const status =
      String(effect?.flags?.core?.statusId ?? "").toLowerCase() ||
      String(Array.isArray(effect?.statuses) ? effect.statuses[0] ?? "" : "").toLowerCase() ||
      String(effect?.label ?? effect?.name ?? "").toLowerCase();
    return status.includes("dead") || status.includes("deceased") || status.includes("defeated");
  });
}

function actorOwnerFallback(actor: any): string {
  const ownership = actor?.ownership;
  if (ownership && Number((ownership as any).default ?? 0) >= 3) return "All Players";
  return "Unknown";
}

function summarizePartyActor(actor: any, worldId: string, authStore: any) {
  const unwrapped = unwrapActorSnapshot(actor);
  const actorId = String(unwrapped?.id ?? unwrapped?._id ?? "").trim();
  if (!actorId) return null;
  if (String(unwrapped?.type ?? "").toLowerCase() !== "character") return null;

  const owners = authStore.listUsersForActorInWorld(worldId, actorId);
  const ownerNames = owners
    .map((owner: any) => String(owner?.displayName ?? owner?.username ?? "").trim())
    .filter(Boolean);

  return {
    id: actorId,
    name: String(unwrapped?.name ?? actorId).trim() || actorId,
    img: actorImage(unwrapped),
    level: actorLevel(unwrapped),
    species: actorSpecies(unwrapped),
    className: actorClass(unwrapped),
    ownerIds: owners.map((owner: any) => String(owner?.userId ?? "").trim()).filter(Boolean),
    ownerNames: ownerNames.length ? Array.from(new Set(ownerNames)).join(", ") : actorOwnerFallback(unwrapped),
    activeMember: Boolean(unwrapped?.flags?.vaulthero?.party?.activeMember),
    deceased: actorDeceased(unwrapped),
    location: actorLocation(unwrapped),
  };
}

function isCharacterSnapshot(actor: any): boolean {
  const unwrapped = unwrapActorSnapshot(actor);
  return String(unwrapped?.type ?? "").toLowerCase() === "character";
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
      const filteredActors = actors.filter((a: any) =>
        allowed.has(String(a?.id ?? "")) && String(a?.type ?? "").toLowerCase() === "character"
      );

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
        changed = changed.filter((a: any) =>
          allowed.has(String(a?.id ?? "")) && String(a?.type ?? "").toLowerCase() === "character"
        );
      }

      return res.json({ ok: true, worldId, since, count: changed.length, actors: changed });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:worldId/party", requireWorldMember, async (req, res, next) => {
    try {
      const worldId = asParamString(req.params.worldId);
      const manifest = await actorsStore.readActorsManifest(worldId);
      const manifestActors = Array.isArray((manifest as any)?.actors) ? (manifest as any).actors : [];
      const actorIds: string[] = manifestActors.length
        ? manifestActors.map((actor: any) => String(actor?.id ?? actor?._id ?? "").trim()).filter(Boolean)
        : await actorsStore.listActorIds(worldId);

      const summaries = await Promise.all(
        Array.from(new Set(actorIds)).map(async (actorId) => {
          const actor = await actorsStore.readActor(worldId, actorId);
          return summarizePartyActor(actor, worldId, authStore);
        })
      );

      return res.json({
        ok: true,
        worldId,
        party: summaries.filter(Boolean),
      });
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

      if (!isApiKeySuperuser(anyReq)) {
        const userId = getVaultUserId(anyReq);
        if (userId && !authStore.isWorldDm(worldId, userId) && !isCharacterSnapshot(actor)) {
          return next(forbidden("Actor access denied"));
        }
      }

      return res.json({ ok: true, actor: unwrapActorSnapshot(actor, actorId) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
