import { Router } from "express";
import { makeRequireUser } from "../middleware/authz.js";
export function makeInvitesRedeemRouter(deps) {
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
            const userId = req.session?.userId;
            if (!userId)
                return res.status(401).json({ ok: false, error: "Login required" });
            const { code } = req.body;
            const r = await authStore.redeemInvite({
                code: String(code ?? ""),
                vaultUserId: userId
            });
            if (!r.ok)
                return res.status(400).json({ ok: false, error: r.error });
            return res.json({ ok: true, worldId: r.worldId, foundryUserId: r.foundryUserId });
        }
        catch (err) {
            next(err);
        }
    });
    return router;
}
//# sourceMappingURL=invites.js.map