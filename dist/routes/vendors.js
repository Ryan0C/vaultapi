// @ts-nocheck
// src/routes/vendors.ts
import { Router } from "express";
import { vendorStore } from "../stores/vendorStore.js";
function isApiKeySuperuser(req) {
    return req.auth?.kind === "apiKey" && !!req.auth?.superuser;
}
function getSessionUserId(req) {
    return req.session?.userId ?? null;
}
function ok(res, body) {
    res.setHeader("Cache-Control", "no-store");
    return res.json({ ok: true, ...body });
}
function bad(res, error, status = 400) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(status).json({ ok: false, error });
}
function isDm(deps, req, worldId) {
    if (isApiKeySuperuser(req))
        return true;
    const userId = getSessionUserId(req);
    return !!(userId && deps.authStore.isWorldDm(worldId, userId));
}
function requireDm(deps, req, worldId) {
    if (isApiKeySuperuser(req))
        return null;
    const userId = getSessionUserId(req);
    if (!userId)
        return { error: true, status: 401, message: "Login required" };
    if (!deps.authStore.isWorldDm(worldId, userId))
        return { error: true, status: 403, message: "DM access required" };
    return null;
}
export function makeVendorsRouter(deps) {
    const router = Router();
    // ── Vendor list + detail ─────────────────────────────────────────────────────
    /** GET /worlds/:worldId/vendors
     *  DMs see ALL vendors (active + inactive); players see only active ones.
     */
    router.get("/:worldId/vendors", (req, res, next) => {
        try {
            const { worldId } = req.params;
            const result = vendorStore.listVendors(worldId, { includeInactive: isDm(deps, req, worldId) });
            return ok(res, result);
        }
        catch (err) {
            next(err);
        }
    });
    /** GET /worlds/:worldId/vendors/:vendorId
     *  Players get a 404 if the vendor is inactive ("closed").
     */
    router.get("/:worldId/vendors/:vendorId", (req, res, next) => {
        try {
            const { worldId, vendorId } = req.params;
            const result = vendorStore.getVendor(vendorId, { includeInactive: isDm(deps, req, worldId) });
            if (!result.ok)
                return bad(res, result.error, 404);
            return ok(res, result);
        }
        catch (err) {
            next(err);
        }
    });
    /** PATCH /worlds/:worldId/vendors/:vendorId/toggle — one-click open/close (DM only) */
    router.patch("/:worldId/vendors/:vendorId/toggle", (req, res, next) => {
        try {
            const { worldId, vendorId } = req.params;
            const dmErr = requireDm(deps, req, worldId);
            if (dmErr)
                return bad(res, dmErr.message, dmErr.status);
            const { isActive } = req.body;
            if (typeof isActive !== "boolean")
                return bad(res, "isActive (boolean) is required");
            const result = vendorStore.updateVendor(vendorId, { isActive });
            if (!result.ok)
                return bad(res, result.error, 404);
            return ok(res, result);
        }
        catch (err) {
            next(err);
        }
    });
    // ── Vendor CRUD (DM only) ───────────────────────────────────────────────────
    /** POST /worlds/:worldId/vendors */
    router.post("/:worldId/vendors", (req, res, next) => {
        try {
            const { worldId } = req.params;
            const dmErr = requireDm(deps, req, worldId);
            if (dmErr)
                return bad(res, dmErr.message, dmErr.status);
            const { name, description, avatarUrl, npcName, greetings, gold } = req.body;
            const result = vendorStore.createVendor({
                worldId,
                name,
                description: description ?? null,
                avatarUrl: avatarUrl ?? null,
                npcName: npcName ?? null,
                greetings: Array.isArray(greetings) ? greetings : [],
                gold: gold ?? 0,
                createdBy: getSessionUserId(req),
            });
            if (!result.ok)
                return bad(res, result.error);
            return ok(res, result);
        }
        catch (err) {
            next(err);
        }
    });
    /** PUT /worlds/:worldId/vendors/:vendorId */
    router.put("/:worldId/vendors/:vendorId", (req, res, next) => {
        try {
            const { worldId, vendorId } = req.params;
            const dmErr = requireDm(deps, req, worldId);
            if (dmErr)
                return bad(res, dmErr.message, dmErr.status);
            const result = vendorStore.updateVendor(vendorId, req.body);
            if (!result.ok)
                return bad(res, result.error, 404);
            return ok(res, result);
        }
        catch (err) {
            next(err);
        }
    });
    /** DELETE /worlds/:worldId/vendors/:vendorId */
    router.delete("/:worldId/vendors/:vendorId", (req, res, next) => {
        try {
            const { worldId, vendorId } = req.params;
            const dmErr = requireDm(deps, req, worldId);
            if (dmErr)
                return bad(res, dmErr.message, dmErr.status);
            const result = vendorStore.deleteVendor(vendorId);
            if (!result.ok)
                return bad(res, result.error, 404);
            return ok(res, result);
        }
        catch (err) {
            next(err);
        }
    });
    // ── Item CRUD (DM only) ─────────────────────────────────────────────────────
    /** POST /worlds/:worldId/vendors/:vendorId/items */
    router.post("/:worldId/vendors/:vendorId/items", (req, res, next) => {
        try {
            const { worldId, vendorId } = req.params;
            const dmErr = requireDm(deps, req, worldId);
            if (dmErr)
                return bad(res, dmErr.message, dmErr.status);
            const { name, description, imageUrl, foundryItemId, priceGold, quantity, maxQuantity, restockIntervalSeconds, restockAmount, sortOrder, } = req.body;
            const result = vendorStore.addItem(vendorId, {
                worldId,
                name,
                description: description ?? null,
                imageUrl: imageUrl ?? null,
                foundryItemId: foundryItemId ?? null,
                priceGold: priceGold ?? 0,
                quantity: quantity ?? 0,
                maxQuantity: maxQuantity ?? quantity ?? 0,
                restockIntervalSeconds: restockIntervalSeconds ?? 0,
                restockAmount: restockAmount ?? 1,
                sortOrder: sortOrder ?? 0,
            });
            if (!result.ok)
                return bad(res, result.error, 404);
            return ok(res, result);
        }
        catch (err) {
            next(err);
        }
    });
    /** PUT /worlds/:worldId/vendors/:vendorId/items/:itemId */
    router.put("/:worldId/vendors/:vendorId/items/:itemId", (req, res, next) => {
        try {
            const { worldId, vendorId, itemId } = req.params;
            const dmErr = requireDm(deps, req, worldId);
            if (dmErr)
                return bad(res, dmErr.message, dmErr.status);
            const result = vendorStore.updateItem(itemId, req.body);
            if (!result.ok)
                return bad(res, result.error, 404);
            return ok(res, result);
        }
        catch (err) {
            next(err);
        }
    });
    /** DELETE /worlds/:worldId/vendors/:vendorId/items/:itemId */
    router.delete("/:worldId/vendors/:vendorId/items/:itemId", (req, res, next) => {
        try {
            const { worldId, vendorId, itemId } = req.params;
            const dmErr = requireDm(deps, req, worldId);
            if (dmErr)
                return bad(res, dmErr.message, dmErr.status);
            const result = vendorStore.deleteItem(itemId);
            if (!result.ok)
                return bad(res, result.error, 404);
            return ok(res, result);
        }
        catch (err) {
            next(err);
        }
    });
    // ── Purchase (any authenticated member) ────────────────────────────────────
    /** POST /worlds/:worldId/vendors/:vendorId/buy */
    router.post("/:worldId/vendors/:vendorId/buy", (req, res, next) => {
        try {
            const { vendorId } = req.params;
            const userId = getSessionUserId(req);
            if (!userId && !isApiKeySuperuser(req))
                return bad(res, "Login required", 401);
            const { itemId, quantity, buyerActorId } = req.body;
            if (!itemId)
                return bad(res, "itemId is required");
            const result = vendorStore.purchase({
                vendorId,
                itemId,
                quantity: quantity ?? 1,
                buyerActorId: buyerActorId ?? null,
                buyerVaultUserId: userId,
            });
            if (!result.ok)
                return bad(res, result.error, 400);
            return ok(res, result);
        }
        catch (err) {
            next(err);
        }
    });
    // ── Transactions (DM only) ──────────────────────────────────────────────────
    /** GET /worlds/:worldId/vendors/:vendorId/transactions */
    router.get("/:worldId/vendors/:vendorId/transactions", (req, res, next) => {
        try {
            const { worldId, vendorId } = req.params;
            const dmErr = requireDm(deps, req, worldId);
            if (dmErr)
                return bad(res, dmErr.message, dmErr.status);
            const limit = Number(req.query.limit) || 200;
            const result = vendorStore.listTransactions({ worldId, vendorId, limit });
            return ok(res, result);
        }
        catch (err) {
            next(err);
        }
    });
    return router;
}
//# sourceMappingURL=vendors.js.map