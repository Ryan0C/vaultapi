// @ts-nocheck
import { Router } from "express";
import { makeRequireWorldDm } from "../middleware/authz.js";
// or: import { makeRequireWorldRole } from "../middleware/authz.js";
export function makeWorldInvitesRouter(deps) {
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
            const worldId = req.params.worldId;
            const anyReq = req;
            const sessionUserId = anyReq.session?.userId;
            // If you want API-key superuser to be able to create invites, attribute to any superadmin:
            let createdBy = sessionUserId;
            if (!createdBy && anyReq.auth?.kind === "apiKey" && anyReq.auth?.superuser) {
                createdBy = authStore.getAnySuperadminId();
            }
            if (!createdBy)
                return res.status(401).json({ ok: false, error: "Login required" });
            const { foundryUserId, expiresMinutes, role } = req.body;
            const inv = authStore.createInvite({
                worldId,
                foundryUserId: String(foundryUserId ?? ""),
                role: (role ?? "player"), // 'dm' | 'player' | 'observer'
                createdBy,
                expiresMinutes: expiresMinutes ? Number(expiresMinutes) : undefined
            });
            // IMPORTANT: return raw code ONCE
            return res.json({ ok: true, inviteId: inv.inviteId, code: inv.code });
        }
        catch (err) {
            next(err);
        }
    });
    return router;
}
//# sourceMappingURL=worldInvites.js.map