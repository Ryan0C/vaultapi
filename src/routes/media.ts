import { Router } from "express";
import path from "node:path";
import fs from "node:fs";
import type { CreateAppDeps } from "../app.js";
import { makeRequireUser } from "../middleware/authz.js";
import { forbidden } from "../utils/errors.js";

// same helper as before
function safeResolveFromRoots(roots: string[], rel: string) {
  const decoded = decodeURIComponent(rel);
  if (!decoded || decoded.includes("\0")) return null;
  if (path.isAbsolute(decoded)) return null;

  for (const root of roots) {
    const abs = path.resolve(root, decoded);
    const rootAbs = path.resolve(root);
    if (!abs.startsWith(rootAbs + path.sep) && abs !== rootAbs) continue;

    if (fs.existsSync(abs) && !fs.statSync(abs).isDirectory()) return abs;
  }
  return null;
}

// media.ts
export function makeMediaRouter(deps: CreateAppDeps) {
  const router = Router();
  const requireUser = makeRequireUser();

  router.get(/.*/, requireUser, (req, res, next) => {
    try {
      const dataRoot = deps.foundryDataRoot;
      if (!dataRoot) return next(forbidden("FOUNDRY_DATA_ROOT not configured"));

      const publicRoot = deps.foundryPublicRoot; // ✅ add this to deps
      // If mounted at /media, req.path is like "/icons/....webp"
      const rel = (req.path ?? "").replace(/^\/+/, "");

      // ✅ Candidate roots (order matters)
      const roots: string[] = [];

      // If it’s a core path, prefer Foundry public
      if (publicRoot && rel.startsWith("icons/")) roots.push(publicRoot);

      // Usual data roots
      roots.push(
        dataRoot,
        path.join(dataRoot, "systems"),
        path.join(dataRoot, "modules"),
        path.join(dataRoot, "worlds"),
      );

      // As a fallback, also allow publicRoot for anything
      if (publicRoot && !roots.includes(publicRoot)) roots.push(publicRoot);

      const abs = safeResolveFromRoots(roots, rel);
      if (!abs) return res.status(404).json({ ok: false, error: "Media not found", rel, roots });

      res.setHeader("Cache-Control", "public, max-age=3600");
      return res.sendFile(abs);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

