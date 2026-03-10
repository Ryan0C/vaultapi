// @ts-nocheck
// src/routes/adminUsers.ts
import { Router } from "express";
import type { CreateAppDeps } from "../app.js";
import { makeRequireSuperadmin } from "../middleware/authz.js";
import type { WorldRole, ActorPermission } from "../services/authStore.js";

const WORLD_ROLES = new Set<WorldRole>(["dm", "player", "observer"]);
const ACTOR_PERMS = new Set<ActorPermission>(["owner", "editor", "viewer"]);

function asNonEmptyString(v: any): string | null {
  const s = String(v ?? "").trim();
  return s ? s : null;
}

function asWorldRole(v: any): WorldRole {
  const s = String(v ?? "").trim().toLowerCase() as WorldRole;
  return WORLD_ROLES.has(s) ? s : "player";
}

function asActorPerm(v: any): ActorPermission {
  const s = String(v ?? "").trim().toLowerCase() as ActorPermission;
  return ACTOR_PERMS.has(s) ? s : "owner";
}

function asMinutes(v: any, fallback = 60): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  // prevent silly values
  return Math.min(Math.floor(n), 60 * 24 * 7); // max 7 days
}

function badRequest(res: any, error: string) {
  return res.status(400).json({ ok: false, error });
}
function notFound(res: any, error: string) {
  return res.status(404).json({ ok: false, error });
}

export function makeAdminUsersRouter(deps: CreateAppDeps) {
  const router = Router();
  const requireSuperadmin = makeRequireSuperadmin(deps.authStore);

  function resolveCreatedBy(req: any): string {
    const sessionUserId: string | undefined = req.session?.userId;
    if (sessionUserId) return sessionUserId;

    if (req.auth?.kind === "apiKey" && req.auth?.superuser) {
      return deps.authStore.getAnySuperadminId();
    }

    // requireSuperadmin should prevent reaching here without a user
    return deps.authStore.getAnySuperadminId();
  }

  function assertUserExists(res: any, userId: string): boolean {
    const exists = deps.authStore.getUserById(userId);
    if (!exists) {
      notFound(res, "User not found");
      return false;
    }
    return true;
  }

  // -----------------------------
  // Users
  // -----------------------------
  router.get("/users", requireSuperadmin, (_req, res) => {
    const users = deps.authStore.listUsers();
    return res.json({ ok: true, users });
  });

  router.post("/users", requireSuperadmin, (req, res) => {
    const username = asNonEmptyString(req.body?.username ?? req.body?.email);
    const isSuperadmin = !!req.body?.isSuperadmin;

    if (!username) return badRequest(res, "username is required");

    const createdBy = resolveCreatedBy(req as any);

    const r = deps.authStore.createUser({
      username,
      isSuperadmin,
      createdBy
    });

    if (!r.ok) return badRequest(res, r.error);

    return res.status(201).json({
      ok: true,
      user: { id: r.userId, username: r.username, email: r.email, isSuperadmin },
      // token returned ONCE
      reset: { resetId: r.resetId, token: r.resetToken }
    });
  });

  router.post("/users/:userId/reset", requireSuperadmin, (req, res) => {
    const userId = asNonEmptyString(req.params.userId);
    if (!userId) return badRequest(res, "userId is required");
    if (!assertUserExists(res, userId)) return;

    const createdBy = resolveCreatedBy(req as any);
    const minutes = asMinutes(req.body?.minutes, 60);

    const reset = deps.authStore.createPasswordReset(userId, createdBy, minutes);
    return res.json({ ok: true, reset });
  });

  // -----------------------------
  // Campaign (World) membership
  // world_user_links(vault_user_id, world_id, foundry_user_id, role, linked_at)
  // -----------------------------
  router.get("/users/:userId/worlds", requireSuperadmin, (req, res) => {
    const userId = asNonEmptyString(req.params.userId);
    if (!userId) return badRequest(res, "userId is required");
    if (!assertUserExists(res, userId)) return;

    const links = deps.authStore.listUserWorldLinks(userId);
    return res.json({ ok: true, links });
  });

  router.post("/users/:userId/worlds", requireSuperadmin, (req, res) => {
    const userId = asNonEmptyString(req.params.userId);
    if (!userId) return badRequest(res, "userId is required");
    if (!assertUserExists(res, userId)) return;

    const worldId = asNonEmptyString(req.body?.worldId);
    if (!worldId) return badRequest(res, "worldId is required");

    const foundryUserId = asNonEmptyString(req.body?.foundryUserId); // optional
    const role = asWorldRole(req.body?.role);

    // NOTE: this method must exist in AuthStore (see below)
    deps.authStore.linkUserToWorld({
      vaultUserId: userId,
      worldId: String(worldId),
      foundryUserId: foundryUserId ? String(foundryUserId) : null,
      role: asWorldRole(role)
    });

    return res.status(201).json({ ok: true });
  });

  router.delete("/users/:userId/worlds/:worldId", requireSuperadmin, (req, res) => {
    const userId = asNonEmptyString(req.params.userId);
    const worldId = asNonEmptyString(req.params.worldId);
    if (!userId) return badRequest(res, "userId is required");
    if (!worldId) return badRequest(res, "worldId is required");
    if (!assertUserExists(res, userId)) return;

    deps.authStore.unlinkUserFromWorld({ vaultUserId: userId, worldId });
    return res.json({ ok: true });
  });

  // -----------------------------
  // Character (Actor) assignment
  // world_actor_links(world_id, actor_id, vault_user_id, permission, linked_at)
  // -----------------------------
  router.get("/users/:userId/actors", requireSuperadmin, (req, res) => {
    const userId = asNonEmptyString(req.params.userId);
    if (!userId) return badRequest(res, "userId is required");
    if (!assertUserExists(res, userId)) return;

    // NOTE: this method must exist in AuthStore (see below)
    const links = deps.authStore.listActorLinksForUser(userId);
    return res.json({ ok: true, links });
  });

  router.post("/users/:userId/actors", requireSuperadmin, (req, res) => {
    const userId = asNonEmptyString(req.params.userId);
    if (!userId) return badRequest(res, "userId is required");
    if (!assertUserExists(res, userId)) return;

    const worldId = asNonEmptyString(req.body?.worldId);
    const actorId = asNonEmptyString(req.body?.actorId);
    if (!worldId || !actorId) return badRequest(res, "worldId and actorId are required");

    const permission = asActorPerm(req.body?.permission);

    deps.authStore.linkActorToUser({
      worldId,
      actorId,
      vaultUserId: userId,
      permission
    });

    return res.status(201).json({ ok: true });
  });

  // cleaner than DELETE-with-body
  router.delete("/users/:userId/actors/:worldId/:actorId", requireSuperadmin, (req, res) => {
    const userId = asNonEmptyString(req.params.userId);
    const worldId = asNonEmptyString(req.params.worldId);
    const actorId = asNonEmptyString(req.params.actorId);

    if (!userId) return badRequest(res, "userId is required");
    if (!worldId) return badRequest(res, "worldId is required");
    if (!actorId) return badRequest(res, "actorId is required");
    if (!assertUserExists(res, userId)) return;

    deps.authStore.unlinkActorFromUser({ worldId, actorId, vaultUserId: userId });
    return res.json({ ok: true });
  });

  return router;
}
