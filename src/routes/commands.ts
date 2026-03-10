// @ts-nocheck
import { Router } from "express";
import type { CreateAppDeps } from "../app.js";
import { makeRequireWorldMember } from "../middleware/authz.js";
import { forbidden, unauthorized } from "../utils/errors.js";
import { makeRequireCommandAccess } from "../middleware/commandPolicy.js";

function isApiKeySuperuser(req: any): boolean {
  return req.auth?.kind === "apiKey" && !!req.auth?.superuser;
}

function getSessionUserId(req: any): string | null {
  return req.session?.userId ?? null;
}

function getUserEnvelope(deps: CreateAppDeps, req: any, worldId: string) {
  // try to include both appUserId + foundryUserId if you have a link table
  const appUserId = getSessionUserId(req) ?? undefined;

  let foundryUserId: string | undefined = undefined;
  if (appUserId) {
    const links = deps.authStore.listUserWorldLinks(appUserId);
    const link = links.find((l: any) => String(l.worldId) === String(worldId));
    if (link?.foundryUserId) foundryUserId = String(link.foundryUserId);
  }

  return { appUserId, foundryUserId };
}

async function requireCommandWriteAccess(deps: CreateAppDeps, req: any, worldId: string) {
  // Superuser api key can do anything
  if (isApiKeySuperuser(req)) return { isDm: true };

  const userId = getSessionUserId(req);
  if (!userId) throw unauthorized("Login required");

  const isDm = deps.authStore.isWorldDm(worldId, userId);
  if (isDm) return { isDm: true };

  // Optional: allow players via policy later.
  // Default: DM-only.
  const policy = await deps.vault.readPolicyMeta(worldId);
  const cmdPolicy = policy?.commandPolicy ?? {};
  const enabled = cmdPolicy?.enabled !== false; // default true
  if (!enabled) throw forbidden("Commands are disabled by world policy");

  const playerAccess = String(cmdPolicy?.playerAccess ?? "dmOnly");
  if (playerAccess !== "allow") throw forbidden("Commands are DM-only for this world");

  return { isDm: false };
}

function cleanStr(v: any) {
  const s = String(v ?? "").trim();
  return s || "";
}

function safeCmdType(t: any) {
  const s = cleanStr(t);
  // keep this permissive now; you can tighten by allowlist per route later
  if (!s) return "";
  if (s.length > 128) return "";
  return s;
}

export function makeCommandsRouter(deps: CreateAppDeps) {
  const router = Router();
  const requireWorldMember = makeRequireWorldMember(deps.authStore);
  const requireCommandAccess = makeRequireCommandAccess(deps);

  /**
   * POST /worlds/:worldId/commands
   * Body: { type, version?, actorId?, payload?, ifMatch?, return?, requestId? }
   */
  router.post("/:worldId/commands", requireWorldMember, requireCommandAccess, async (req, res, next) => {
    try {
      res.setHeader("Cache-Control", "no-store");

      const anyReq = req as any;
      const { worldId } = req.params;

      await requireCommandWriteAccess(deps, anyReq, worldId);

      const type = safeCmdType(req.body?.type);
      if (!type) return res.status(400).json({ ok: false, error: "Missing/invalid command type" });

      const version = Number(req.body?.version ?? 1) || 1;
      const actorId = cleanStr(req.body?.actorId) || undefined;

      const payload = req.body?.payload ?? {};
      const ifMatch = req.body?.ifMatch ?? undefined;
      const ret = req.body?.return ?? undefined;

      const requestId = cleanStr(req.body?.requestId) || undefined;

      const user = getUserEnvelope(deps, anyReq, worldId);

      const queued = await deps.vault.enqueueCommand(worldId, {
        requestId,
        type,
        version,
        actorId,
        user,
        payload,
        ifMatch,
        return: ret,
      });

      return res.status(202).json({
        ok: true,
        worldId,
        requestId: queued.requestId,
        requestPath: queued.requestPath,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /worlds/:worldId/commands/requests/:requestId
   * Poll ack written by Foundry processor.
   */
  router.get("/:worldId/commands/requests/:requestId", requireWorldMember, requireCommandAccess, async (req, res, next) => {
    try {
      res.setHeader("Cache-Control", "no-store");

      const { worldId, requestId } = req.params;

      const ack = await deps.vault.readCommandAck(worldId, requestId);
      if (!ack) return res.status(404).json({ ok: false, pending: true });

      return res.json({ ok: true, ack });
    } catch (err) {
      next(err);
    }
  });

  /* ----------------------------------------------------- */
  /* Convenience endpoints (optional, but nice UX)          */
  /* These call your VaultStore cmd* helpers directly.      */
  /* ----------------------------------------------------- */

  router.post("/:worldId/actors", requireWorldMember, requireCommandAccess, async (req, res, next) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      const anyReq = req as any;
      const { worldId } = req.params;

      await requireCommandWriteAccess(deps, anyReq, worldId);

      const user = getUserEnvelope(deps, anyReq, worldId);
      const queued = await deps.vault.cmdActorCreate(worldId, req.body ?? {}, user);

      return res.status(202).json({ ok: true, worldId, requestId: queued.requestId });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/:worldId/actors/:actorId", requireWorldMember, requireCommandAccess, async (req, res, next) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      const anyReq = req as any;
      const { worldId, actorId } = req.params;

      await requireCommandWriteAccess(deps, anyReq, worldId);

      const user = getUserEnvelope(deps, anyReq, worldId);
      const queued = await deps.vault.cmdActorUpdate(worldId, actorId, req.body?.payload ?? req.body ?? {}, {
        user,
        ifMatch: req.body?.ifMatch,
        returnActor: req.body?.returnActor ?? true,
      });

      return res.status(202).json({ ok: true, worldId, actorId, requestId: queued.requestId });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:worldId/actors/:actorId", requireWorldMember, requireCommandAccess, async (req, res, next) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      const anyReq = req as any;
      const { worldId, actorId } = req.params;

      await requireCommandWriteAccess(deps, anyReq, worldId);

      const user = getUserEnvelope(deps, anyReq, worldId);
      const queued = await deps.vault.cmdActorDelete(worldId, actorId, user);

      return res.status(202).json({ ok: true, worldId, actorId, requestId: queued.requestId });
    } catch (err) {
      next(err);
    }
  });

//   router.post("/:worldId/quests", requireWorldMember, requireCommandAccess, async (req, res, next) => {
//     try {
//       res.setHeader("Cache-Control", "no-store");
//       const anyReq = req as any;
//       const { worldId } = req.params;

//       await requireCommandWriteAccess(deps, anyReq, worldId);

//       const user = getUserEnvelope(deps, anyReq, worldId);
//       const queued = await deps.vault.cmdQuestCreate(worldId, req.body ?? {}, user);

//       return res.status(202).json({ ok: true, worldId, requestId: queued.requestId });
//     } catch (err) {
//       next(err);
//     }
//   });

//   router.post("/:worldId/actors/:actorId/quests/assign", requireWorldMember, requireCommandAccess, async (req, res, next) => {
//     try {
//       res.setHeader("Cache-Control", "no-store");
//       const anyReq = req as any;
//       const { worldId, actorId } = req.params;

//       await requireCommandWriteAccess(deps, anyReq, worldId);

//       const user = getUserEnvelope(deps, anyReq, worldId);
//       const queued = await deps.vault.cmdQuestAssign(worldId, actorId, req.body ?? {}, user);

//       return res.status(202).json({ ok: true, worldId, actorId, requestId: queued.requestId });
//     } catch (err) {
//       next(err);
//     }
//   });

//   router.post("/:worldId/intel", requireWorldMember, requireCommandAccess, async (req, res, next) => {
//     try {
//       res.setHeader("Cache-Control", "no-store");
//       const anyReq = req as any;
//       const { worldId } = req.params;

//       await requireCommandWriteAccess(deps, anyReq, worldId);

//       const user = getUserEnvelope(deps, anyReq, worldId);
//       const queued = await deps.vault.cmdIntelCreate(worldId, req.body ?? {}, user);

//       return res.status(202).json({ ok: true, worldId, requestId: queued.requestId });
//     } catch (err) {
//       next(err);
//     }
//   });

  return router;
}