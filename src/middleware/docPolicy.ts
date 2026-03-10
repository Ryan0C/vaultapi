import type { Request, Response, NextFunction } from "express";
import { forbidden, unauthorized } from "../utils/errors.js";
import type { CreateAppDeps } from "../app.js";

function isApiKeySuperuser(req: any): boolean {
  return req.auth?.kind === "apiKey" && !!req.auth?.superuser;
}

function asParamString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return String(value[0] ?? "").trim();
  return String(value ?? "").trim();
}

export function makeRequireDocPickerAccess(deps: CreateAppDeps) {
  const { vault, authStore } = deps;

  return async function requireDocPickerAccess(req: Request, _res: Response, next: NextFunction) {
    try {
      const anyReq = req as any;

      // API key superuser bypass
      if (isApiKeySuperuser(anyReq)) return next();

      const userId = anyReq.session?.userId;
      if (!userId) return next(unauthorized("Login required"));

      const worldId = asParamString(req.params.worldId);
      if (!worldId) return next(forbidden("Missing worldId"));

      // DM always allowed
      if (authStore.isWorldDm(worldId, userId)) return next();

      // Non-DM: must be enabled by policy
      const policy = await vault.readPolicyMeta(worldId);
      const picker = policy?.docPolicy?.picker;

      if (!picker?.enabled) return next(forbidden("Picker access is disabled for this world"));

      const playerAccess = String(picker.playerAccess ?? "dmOnly");
      if (playerAccess === "dmOnly") return next(forbidden("Picker access is DM-only for this world"));

      // otherwise allowed (route still enforces allowedKinds + allowlisted packs)
      return next();
    } catch (err) {
      return next(err);
    }
  };
}
