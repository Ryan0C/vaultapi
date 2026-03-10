import { unauthorized, forbidden } from "../utils/errors.js";
function asParamString(value) {
    if (Array.isArray(value))
        return String(value[0] ?? "").trim();
    return String(value ?? "").trim();
}
export function makeRequireUser() {
    return function requireUser(req, _res, next) {
        const anyReq = req;
        // API key = superuser (bypass)
        if (anyReq.auth?.kind === "apiKey" && anyReq.auth?.superuser)
            return next();
        const userId = anyReq.session?.userId;
        if (!userId)
            return next(unauthorized("Login required"));
        return next();
    };
}
/**
 * Require membership in the world (any role: dm|player|observer).
 */
export function makeRequireWorldMember(authStore) {
    return function requireWorldMember(req, _res, next) {
        const anyReq = req;
        // API key = superuser bypass
        if (anyReq.auth?.kind === "apiKey" && anyReq.auth?.superuser)
            return next();
        const userId = anyReq.session?.userId;
        if (!userId)
            return next(unauthorized("Login required"));
        const worldId = asParamString(req.params.worldId);
        if (!worldId)
            return next(forbidden("Missing worldId"));
        const ok = authStore.isWorldMember(worldId, userId);
        if (!ok)
            return next(forbidden("World membership required"));
        return next();
    };
}
/**
 * Require a specific role (or one of a set of roles) for a world.
 * Example: makeRequireWorldRole(authStore, ["dm"]) or ["dm","observer"]
 */
export function makeRequireWorldRole(authStore, roles) {
    const allow = Array.isArray(roles) ? roles : [roles];
    return function requireWorldRole(req, _res, next) {
        const anyReq = req;
        // API key = superuser bypass
        if (anyReq.auth?.kind === "apiKey" && anyReq.auth?.superuser)
            return next();
        const userId = anyReq.session?.userId;
        if (!userId)
            return next(unauthorized("Login required"));
        const worldId = asParamString(req.params.worldId);
        if (!worldId)
            return next(forbidden("Missing worldId"));
        const role = authStore.getWorldRole(worldId, userId);
        if (!role)
            return next(forbidden("World membership required"));
        if (!allow.includes(role)) {
            return next(forbidden(`World role required: ${allow.join(" or ")}`));
        }
        return next();
    };
}
/**
 * DM-only gate (replacement for old "world admin").
 */
export function makeRequireWorldDm(authStore) {
    return makeRequireWorldRole(authStore, ["dm"]);
}
export function makeRequireSuperadmin(authStore) {
    return function requireSuperadmin(req, _res, next) {
        const anyReq = req;
        // API key = superuser bypass
        if (anyReq.auth?.kind === "apiKey" && anyReq.auth?.superuser)
            return next();
        const userId = anyReq.session?.userId;
        if (!userId)
            return next(unauthorized("Login required"));
        const u = authStore.getUserById(userId);
        if (!u?.is_superadmin)
            return next(forbidden("Superadmin required"));
        return next();
    };
}
//# sourceMappingURL=authz.js.map