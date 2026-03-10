// middleware/worldOnline.ts
import type { Request, Response, NextFunction } from "express";
import { forbidden } from "../utils/errors.js";
import type { CreateAppDeps } from "../app.js";

export function makeRequireWorldOnline(deps: CreateAppDeps, ttlMs = 10_000) {
  const { vault } = deps;

  return async function requireWorldOnline(req: Request, res: Response, next: NextFunction) {
    try {
      const worldId = String(req.params.worldId ?? "").trim();
      if (!worldId) return next(forbidden("Missing worldId"));

      const status = await vault.readStatusMeta(worldId);
      const last = Date.parse(status?.lastHeartbeatAt ?? "");
      const ageMs = Number.isFinite(last) ? Date.now() - last : Infinity;

      const online = ageMs < ttlMs;

      if (!online) {
        return res.status(503).json({
          ok: false,
          error: "World is offline",
          worldId,
          lastHeartbeatAt: status?.lastHeartbeatAt ?? null,
          ageMs: Number.isFinite(ageMs) ? ageMs : null,
        });
      }

      return next();
    } catch (e) {
      return next(e);
    }
  };
}