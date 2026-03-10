import { Router } from "express";
import { makeRequireUser } from "../middleware/authz.js";
import type { CreateAppDeps } from "../app.js";

export function makeInvitesRedeemRouter(deps: CreateAppDeps) {
  const { authStore } = deps;
  const router = Router();

  // IMPORTANT: require real session user (do NOT allow api-key bypass here)
  const requireUser = makeRequireUser();

  /**
   * POST /invites/redeem
   * Redeems an invite and links the logged-in vault user to (worldId + foundryUserId).
   * Requires: session login.
   */
  router.post("/redeem", requireUser, async (req, res, next) => {
    try {
      const userId = (req as any).session?.userId as string | undefined;
      if (!userId) return res.status(401).json({ ok: false, error: "Login required" });

      const { code } = req.body as any;

      const r = await authStore.redeemInvite({
        code: String(code ?? ""),
        vaultUserId: userId
      });

      if (!r.ok) return res.status(400).json({ ok: false, error: r.error });

      return res.json({ ok: true, worldId: r.worldId, foundryUserId: r.foundryUserId });
    } catch (err) {
      next(err);
    }
  });

  return router;
}