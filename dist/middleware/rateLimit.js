// src/middleware/rateLimit.ts
import rateLimit from "express-rate-limit";
export function makeLoginLimiter() {
    return rateLimit({
        windowMs: 15 * 60 * 1000, // 15 min
        max: 20, // per IP per window
        standardHeaders: true,
        legacyHeaders: false,
        message: { ok: false, error: "Too many login attempts. Try again later." }
    });
}
export function makeResetLimiter() {
    return rateLimit({
        windowMs: 15 * 60 * 1000, // 15 min
        max: 10,
        standardHeaders: true,
        legacyHeaders: false,
        message: { ok: false, error: "Too many reset attempts. Try again later." }
    });
}
//# sourceMappingURL=rateLimit.js.map