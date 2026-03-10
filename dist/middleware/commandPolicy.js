import { forbidden, unauthorized } from "../utils/errors.js";
function isApiKeySuperuser(req) {
    return req.auth?.kind === "apiKey" && !!req.auth?.superuser;
}
function asParamString(value) {
    if (Array.isArray(value))
        return String(value[0] ?? "").trim();
    return String(value ?? "").trim();
}
export function makeRequireCommandAccess(deps) {
    const { vault, authStore } = deps;
    return async function requireCommandAccess(req, _res, next) {
        try {
            const anyReq = req;
            // API key superuser bypass
            if (isApiKeySuperuser(anyReq))
                return next();
            const userId = anyReq.session?.userId;
            if (!userId)
                return next(unauthorized("Login required"));
            const worldId = asParamString(req.params.worldId);
            if (!worldId)
                return next(forbidden("Missing worldId"));
            // DM always allowed
            if (authStore.isWorldDm(worldId, userId))
                return next();
            // Non-DM: must be enabled by policy
            const policy = await vault.readPolicyMeta(worldId);
            const cmd = policy?.commandPolicy;
            if (!cmd?.enabled)
                return next(forbidden("Commands are disabled for this world"));
            // Default to dmOnly if unset
            const playerAccess = String(cmd.playerAccess ?? "dmOnly");
            if (playerAccess === "dmOnly")
                return next(forbidden("Commands are DM-only for this world"));
            // Allowed (route can still enforce per-command rules)
            return next();
        }
        catch (err) {
            return next(err);
        }
    };
}
//# sourceMappingURL=commandPolicy.js.map