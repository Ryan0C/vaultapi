// @ts-nocheck
import { Router } from "express";
import { makeLoginLimiter, makeResetLimiter } from "../middleware/rateLimit.js";
export function makeAuthRouter(deps) {
    const { vault, authStore } = deps;
    const router = Router();
    const loginLimiter = makeLoginLimiter();
    const resetLimiter = makeResetLimiter();
    router.post("/login", loginLimiter, (req, res) => {
        const { username, email, password } = req.body;
        const identifier = String(username ?? email ?? "");
        const result = authStore.verifyLogin(identifier, String(password ?? ""));
        if (!result.ok)
            return res.status(401).json({ ok: false, error: result.error });
        req.session.userId = result.user.id;
        return res.json({
            ok: true,
            user: {
                id: result.user.id,
                username: result.user.username,
                email: result.user.email,
                isSuperadmin: !!result.user.is_superadmin
            },
            mustResetPassword: !!result.user.must_reset_password
        });
    });
    router.post("/logout", (req, res) => {
        req.session?.destroy?.(() => { });
        res.json({ ok: true });
    });
    router.get("/me", (req, res) => {
        const userId = req.session?.userId;
        if (!userId)
            return res.json({ ok: true, user: null });
        const user = authStore.getUserById(userId);
        return res.json({ ok: true, user });
    });
    router.post("/set-password", (req, res) => {
        const userId = req.session?.userId;
        if (!userId)
            return res.status(401).json({ ok: false, error: "Login required" });
        const { newPassword } = req.body;
        authStore.setPassword(userId, String(newPassword ?? ""));
        res.json({ ok: true });
    });
    router.get("/me/worlds", (req, res) => {
        const userId = req.session?.userId;
        // api key superuser can’t be “me” (no session identity)
        if (!userId)
            return res.status(401).json({ ok: false, error: "Login required" });
        const worlds = authStore.getLinkedWorldsForUser(userId);
        return res.json({ ok: true, worlds });
    });
    router.post("/reset-password", resetLimiter, (req, res) => {
        const { token, newPassword } = req.body;
        const r = authStore.consumePasswordReset(String(token ?? ""), String(newPassword ?? ""));
        if (!r.ok)
            return res.status(400).json({ ok: false, error: r.error });
        res.json({ ok: true });
    });
    return router;
}
//# sourceMappingURL=auth.js.map