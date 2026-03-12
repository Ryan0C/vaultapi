// src/routes/me.ts
import { Router } from "express";
import type { CreateAppDeps } from "../app.js";
import { makeRequireUser } from "../middleware/authz.js";
import { asParamString } from "./actorSummary.js";

function deriveWorldStatus(status: any | null, ttlMs = 10_000) {
  const nowMs = Date.now();

  const rawLast =
    status?.lastHeartbeatAt ??
    status?.lastHeartbeat ??
    status?.status?.lastHeartbeatAt ??
    status?.status?.lastHeartbeat ??
    null;

  const lastMs =
    typeof rawLast === "number"
      ? rawLast
      : typeof rawLast === "string"
        ? Date.parse(rawLast)
        : NaN;

  const ageMs = Number.isFinite(lastMs) ? nowMs - lastMs : null;

  let state: "online" | "stale" | "missing" | "clock_skew" = "missing";
  let online = false;

  if (!status) {
    state = "missing";
    online = false;
  } else if (!Number.isFinite(lastMs)) {
    state = "stale";
    online = false;
  } else if ((ageMs ?? 0) < -1000) {
    state = "clock_skew";
    online = true;
  } else if ((ageMs ?? Infinity) < ttlMs) {
    state = "online";
    online = true;
  } else {
    state = "stale";
    online = false;
  }

  const startedAt = status?.startedAt ?? status?.status?.startedAt ?? null;
  const isReady =
    typeof status?.isReady === "boolean"
      ? status.isReady
      : typeof status?.status?.isReady === "boolean"
        ? status.status.isReady
        : null;

  const activeUsers =
    typeof status?.activeUsers === "number"
      ? status.activeUsers
      : typeof status?.status?.activeUsers === "number"
        ? status.status.activeUsers
        : null;

  const userCount =
    typeof status?.userCount === "number"
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

// Minimal shape this router needs from the new store
type WorldStore = {
  listWorldIds(): Promise<string[]>;
  readWorldMeta(worldId: string): Promise<any | null>;
  readStatusMeta(worldId: string): Promise<any | null>;
};

type ActorsStore = {
  readActorsManifest(worldId: string): Promise<any | null>;
  listActorIds(worldId: string): Promise<string[]>;
};

export function makeMeRouter(deps: CreateAppDeps) {
  const router = Router();
  const requireUser = makeRequireUser();

  const { authStore, worldStore, actorsStore } = deps as unknown as CreateAppDeps & {
    worldStore: WorldStore;
    actorsStore: ActorsStore;
  };

  function parseIntParam(value: unknown, fallback: number, max: number) {
    const n = Math.trunc(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(max, n));
  }

  function matchesQuery(row: any, query: string) {
    if (!query) return true;
    const hay = [
      row?.name,
      row?.id,
      row?.type,
      row?.worldId,
      row?.worldTitle,
    ].map((value) => String(value ?? "").toLowerCase()).join(" ");
    return hay.includes(query);
  }

  async function readAccessibleActorsForWorld(worldId: string, userId: string, isSuperadmin: boolean) {
    const manifest = await actorsStore.readActorsManifest(worldId);
    const manifestActors = Array.isArray(manifest?.actors) ? manifest.actors : [];
    const isDm = isSuperadmin || authStore.isWorldDm(worldId, userId);

    if (manifestActors.length) {
      if (isDm) return manifestActors;

      const allowed = new Set(
        authStore.listActorsForUserInWorld(worldId, userId).map((link: any) => String(link?.actorId ?? "").trim())
      );
      return manifestActors.filter((actor: any) => {
        const actorId = String(actor?.id ?? actor?._id ?? "").trim();
        return allowed.has(actorId) && String(actor?.type ?? "").toLowerCase() === "character";
      });
    }

    const actorIds = await actorsStore.listActorIds(worldId);
    if (isDm) return actorIds.map((id) => ({ id, type: "character" }));

    const allowed = new Set(
      authStore.listActorsForUserInWorld(worldId, userId).map((link: any) => String(link?.actorId ?? "").trim())
    );
    return actorIds
      .filter((actorId) => allowed.has(actorId))
      .map((id) => ({ id, type: "character" }));
  }

  router.get("/worlds", requireUser, async (req, res, next) => {
    try {
      // prevent caching/304
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      res.removeHeader("ETag");

      const anyReq = req as any;
      const sessionUserId = anyReq.session?.userId as string | undefined;

      const ttlMs = 10_000;

      // Superadmin: all worlds
      if (sessionUserId) {
        const user = authStore.getUserById(sessionUserId);
        if (user?.is_superadmin) {
          const worldIds = await worldStore.listWorldIds();
          const worlds = await Promise.all(
            worldIds.map(async (id) => {
              const [meta, rawStatus] = await Promise.all([
                worldStore.readWorldMeta(id).catch(() => null),
                worldStore.readStatusMeta(id).catch(() => null),
              ]);

              return {
                id,
                meta,
                status: deriveWorldStatus(rawStatus, ttlMs),
              };
            })
          );
          return res.json({ ok: true, worlds, superuser: true });
        }
      }

      // Normal user: linked worlds only
      const userId = sessionUserId ?? null;

      if (!userId) {
        return res.json({ ok: true, worlds: [] });
      }

      const links = authStore.listUserWorldLinks(userId);

      const worlds = await Promise.all(
        links.map(async (l) => {
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
        })
      );

      return res.json({ ok: true, worlds });
    } catch (err) {
      next(err);
    }
  });

  router.get("/actors", requireUser, async (req, res, next) => {
    try {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");

      const anyReq = req as any;
      const sessionUserId = String(anyReq.session?.userId ?? "").trim();
      if (!sessionUserId) {
        return res.json({ ok: true, actors: [], total: 0, count: 0, offset: 0, limit: 0, hasMore: false });
      }

      const user = authStore.getUserById(sessionUserId);
      const isSuperadmin = Boolean(user?.is_superadmin);
      const worldIdFilter = asParamString(req.query.worldId as any);
      const rawKind = asParamString(req.query.kind as any).toLowerCase();
      const kind = rawKind === "npcs" || rawKind === "all" ? rawKind : "characters";
      const query = asParamString(req.query.q as any).toLowerCase();
      const limit = Math.max(1, parseIntParam(req.query.limit, 24, 100));
      const offset = parseIntParam(req.query.offset, 0, 10_000);

      const linkedWorlds = isSuperadmin
        ? (await worldStore.listWorldIds()).map((id) => ({ worldId: id, foundryUserId: null }))
        : authStore.listUserWorldLinks(sessionUserId);

      const targetWorlds = linkedWorlds.filter((link) => {
        const wid = String(link?.worldId ?? "").trim();
        return wid && (!worldIdFilter || wid === worldIdFilter);
      });

      const worldMetaEntries = await Promise.all(
        targetWorlds.map(async (link) => {
          const wid = String(link.worldId ?? "").trim();
          const meta = await worldStore.readWorldMeta(wid).catch(() => null);
          return [wid, meta] as const;
        })
      );
      const worldMetaById = Object.fromEntries(worldMetaEntries);

      const actorRows = (
        await Promise.all(
          targetWorlds.map(async (link) => {
            const wid = String(link.worldId ?? "").trim();
            const worldMeta = worldMetaById[wid];
            const worldTitle = String(worldMeta?.title ?? worldMeta?.name ?? wid).trim() || wid;
            const actors = await readAccessibleActorsForWorld(wid, sessionUserId, isSuperadmin);
            return actors.map((actor: any) => ({
              worldId: wid,
              worldTitle,
              foundryUserId: link?.foundryUserId ?? null,
              id: String(actor?.id ?? actor?._id ?? "").trim(),
              name: String(actor?.name ?? actor?.id ?? actor?._id ?? "").trim(),
              type: String(actor?.type ?? "character").trim().toLowerCase(),
              img: String(actor?.img ?? "").trim(),
              updatedAt: actor?.updatedAt ?? actor?.exportedAt ?? null,
              exportedAt: actor?.exportedAt ?? null,
            })).filter((actor: any) => actor.id);
          })
        )
      ).flat();

      const filtered = actorRows
        .filter((actor) => {
          if (kind === "characters") return actor.type === "character";
          if (kind === "npcs") return actor.type === "npc";
          return true;
        })
        .filter((actor) => matchesQuery(actor, query))
        .sort((a, b) => {
          const aTs = Number(new Date(String(a.updatedAt ?? 0)).getTime()) || 0;
          const bTs = Number(new Date(String(b.updatedAt ?? 0)).getTime()) || 0;
          if (aTs !== bTs) return bTs - aTs;
          if (a.worldTitle !== b.worldTitle) return a.worldTitle.localeCompare(b.worldTitle);
          return String(a.name ?? a.id).localeCompare(String(b.name ?? b.id));
        });

      const paged = filtered.slice(offset, offset + limit);
      return res.json({
        ok: true,
        actors: paged,
        total: filtered.length,
        count: paged.length,
        offset,
        limit,
        hasMore: offset + paged.length < filtered.length,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
