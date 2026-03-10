import { unauthorized } from "../utils/errors.js";
function normalizePath(p) {
    // strip querystring if someone accidentally passes it in
    return p.split("?")[0];
}
function isAllowedPath(reqPath, allow) {
    const p = normalizePath(reqPath);
    for (const ruleRaw of allow) {
        const rule = normalizePath(ruleRaw);
        // support "/health/*" style
        if (rule.endsWith("/*")) {
            const prefix = rule.slice(0, -1); // keep trailing "/"
            if (p.startsWith(prefix))
                return true;
            continue;
        }
        // exact match
        if (p === rule)
            return true;
        // common ergonomic prefix form: "/health/" allows "/health/anything"
        if (rule.endsWith("/") && p.startsWith(rule))
            return true;
    }
    return false;
}
export function makeAuthMiddleware(opts) {
    const allow = opts.allowUnauthedPaths ?? [];
    return function auth(req, _res, next) {
        // Let CORS preflight through
        if (req.method === "OPTIONS")
            return next();
        // Allowlist paths (health, login, reset endpoints, etc)
        if (isAllowedPath(req.path, allow))
            return next();
        // ✅ If logged in via session, allow
        const anyReq = req;
        if (anyReq.session?.userId) {
            anyReq.auth = { kind: "session", userId: anyReq.session.userId };
            return next();
        }
        // Otherwise require API key
        const hdr = req.header("authorization") ?? "";
        const token = hdr.startsWith("Bearer ") ? hdr.slice("Bearer ".length).trim() : "";
        const key = token || req.header("x-api-key") || "";
        if (!key || key !== opts.apiKey)
            return next(unauthorized("Missing or invalid API key"));
        // Optional: mark api-key auth for downstream authz
        anyReq.auth = {
            kind: "apiKey",
            superuser: true,
            vaultUserId: process.env.API_KEY_ACTOR_USER_ID ?? null
        };
        return next();
    };
}
//# sourceMappingURL=auth.js.map