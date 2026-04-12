import { Router, type Request } from "express";
import type { CreateAppDeps } from "../app.js";
import { makeRequireWorldDm } from "../middleware/authz.js";
import type { WorldRole } from "../services/authStore.js";

type InviteRequestBody = {
  foundryUserId?: unknown;
  expiresMinutes?: unknown;
  role?: unknown;
};

type AuthedRequest = Request & {
  auth?: {
    kind?: string;
    superuser?: boolean;
  };
  session?: {
    userId?: string;
  };
};

function asInviteRole(input: unknown): WorldRole {
  return input === "dm" || input === "observer" || input === "player" ? input : "player";
}

function asInviteBody(body: unknown): InviteRequestBody {
  if (body && typeof body === "object") return body as InviteRequestBody;
  return {};
}

function asParamString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return String(value[0] ?? "").trim();
  return String(value ?? "").trim();
}

export function makeWorldInvitesRouter(deps: CreateAppDeps) {
  const { authStore } = deps;
  const router = Router();

  // DM-only can create invites for that world
  const requireWorldDm = makeRequireWorldDm(authStore);

  /**
   * POST /worlds/:worldId/invites
   * Creates an invite bound to a Foundry userId in that world, granting a role.
   * Requires: world dm (session) OR api-key superuser (bypass still handled by middleware)
   */
  router.post("/:worldId/invites", requireWorldDm, (req, res, next) => {
    try {
      const worldId = asParamString(req.params.worldId);
      const authedReq = req as AuthedRequest;
      const sessionUserId = authedReq.session?.userId;

      // If you want API-key superuser to be able to create invites, attribute to any superadmin:
      let createdBy = sessionUserId;
      if (!createdBy && authedReq.auth?.kind === "apiKey" && authedReq.auth?.superuser) {
        createdBy = authStore.getAnySuperadminId();
      }
      if (!createdBy) return res.status(401).json({ ok: false, error: "Login required" });

      const { foundryUserId, expiresMinutes, role } = asInviteBody(req.body);

      const inv = authStore.createInvite({
        worldId,
        foundryUserId: String(foundryUserId ?? ""),
        role: asInviteRole(role), // 'dm' | 'player' | 'observer'
        createdBy,
        expiresMinutes: expiresMinutes == null ? undefined : Number(expiresMinutes)
      });

      // IMPORTANT: return raw code ONCE
      return res.json({ ok: true, inviteId: inv.inviteId, code: inv.code });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
