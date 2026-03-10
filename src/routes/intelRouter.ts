// @ts-nocheck
// /src/routes/intelRouter.ts
import { Router } from "express";
import type { CreateAppDeps } from "../app.js";
import { makeRequireWorldMember } from "../middleware/authz.js";
import { forbidden, unauthorized } from "../utils/errors.js";
import { intelStore } from "../stores/intelStore.js";
import multer from "multer";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";

function isApiKeySuperuser(req: any): boolean {
  return req.auth?.kind === "apiKey" && !!req.auth?.superuser;
}

function getSessionUserId(req: any): string | null {
  return req.session?.userId ?? null;
}

async function requireIntelWriteAccess(deps: CreateAppDeps, req: any, worldId: string) {
  // Superuser api key can do anything
  if (isApiKeySuperuser(req)) return { isDm: true };

  const userId = getSessionUserId(req);
  if (!userId) throw unauthorized("Login required");

  const isDm = deps.authStore.isWorldDm(worldId, userId);
  if (isDm) return { isDm: true };

  // Default DM-only (tight). You can later add a policy switch like commands.
  throw forbidden("Intel is DM-only for this world");
}

// (near top-level, outside makeIntelRouter)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    const ok = ["image/png", "image/jpeg", "image/webp"].includes(file.mimetype);
    cb(ok ? null : new Error("Invalid file type"), ok);
  },
});

function safeId(s: string) {
  return String(s ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
}

function extFromMime(mime: string) {
  const m = String(mime || "").toLowerCase();
  if (m === "image/png") return "png";
  if (m === "image/jpeg") return "jpg";
  if (m === "image/webp") return "webp";
  return "bin";
}

function cleanStr(v: any) {
  const s = String(v ?? "").trim();
  return s || "";
}

function toInt(v: any, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function toIsoOrNull(v: any): string | null {
  const s = cleanStr(v);
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function ok(res: any, body: any) {
  res.setHeader("Cache-Control", "no-store");
  return res.json({ ok: true, ...body });
}

function bad(res: any, error: string, status = 400) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json({ ok: false, error });
}

function normalizeScope(scopeRaw: any): "party" | "player" {
  const s = cleanStr(scopeRaw);
  return s === "player" ? "player" : "party";
}

function normalizeViewerRole(roleRaw: any): "gm" | "player" {
  const s = cleanStr(roleRaw);
  return s === "gm" ? "gm" : "player";
}

async function requireIntelDiscoverAccess(deps: CreateAppDeps, req: any, worldId: string) {
  // superuser ok
  if (isApiKeySuperuser(req)) return { role: "gm" as const };

  const userId = getSessionUserId(req);
  if (!userId) throw unauthorized("Login required");

  // any world member can mark discovered (tighten later if needed)
  // if you want only DMs, remove this and you’re back where you are now
  return { role: deps.authStore.isWorldDm(worldId, userId) ? ("gm" as const) : ("player" as const), userId };
}

export function makeIntelRouter(deps: CreateAppDeps) {
  const router = Router();
  const requireWorldMember = makeRequireWorldMember(deps.authStore);

  /* =========================================================
   * INTEL
   * ========================================================= */


  
  /**
   * GET /worlds/:worldId/intel
   * Query:
   *  - kind=note|map|image|handout|clue
   *  - scope=party|player
   *  - actorId=<viewer actor id>         (for scope filtering + restricted checks)
   *  - viewerRole=gm|player             (gm sees all)
   *  - viewerActorId=<viewer actor id>  (alias; if omitted uses actorId)
   *  - limit=200
   *  - beforeCreatedAt=<ISO>
   */
  router.get("/:worldId/intel", requireWorldMember, async (req, res, next) => {
    try {
      const { worldId } = req.params;

      const list = intelStore.listIntel({
        worldId,
        kind: cleanStr(req.query?.kind) ? (cleanStr(req.query?.kind) as any) : undefined,
        scope: cleanStr(req.query?.scope) ? (normalizeScope(req.query?.scope) as any) : undefined,

        // viewer identity for scope/restricted filtering
        actorId: cleanStr(req.query?.actorId) || undefined,
        viewerRole: normalizeViewerRole(req.query?.viewerRole),
        viewerActorId: cleanStr(req.query?.viewerActorId) || undefined,

        limit: req.query?.limit != null ? toInt(req.query.limit, 200) : undefined,
        beforeCreatedAt: cleanStr(req.query?.beforeCreatedAt) || undefined,
      });

      return ok(res, { worldId, count: list.length, intel: list });
    } catch (err) {
      next(err);
    }
  });

/**
 * GET /worlds/:worldId/intel/discovered
 * Player-facing list:
 *  - only discovered intel
 *  - scope=party OR (scope=player AND actorId==viewerActorId)
 *  - enforces visibility/restricted checks (players/restricted)
 *
 * Query:
 *  - viewerActorId=<viewer actor id> (required to see player-scoped intel)
 *  - kind=note|map|image|handout|clue (optional)
 *  - limit=200 (optional)
 *  - beforeCreatedAt=<ISO> (optional)
 */
router.get("/:worldId/intel/discovered", requireWorldMember, async (req, res, next) => {
  try {
    const { worldId } = req.params;

    const viewerActorId =
      cleanStr(req.query?.viewerActorId ?? req.query?.actorId) || undefined;

        const list = intelStore.listIntel({
        worldId,
        kind: cleanStr(req.query?.kind) ? (cleanStr(req.query?.kind) as any) : undefined,
        viewerRole: "player",
        viewerActorId,
        discoveredOnly: true,

        includeAttachments: true, // ✅ add this

        limit: req.query?.limit != null ? toInt(req.query.limit, 200) : 200,
        beforeCreatedAt: cleanStr(req.query?.beforeCreatedAt) || undefined,
        });

    return ok(res, { worldId, count: list.length, intel: list });
  } catch (err) {
    next(err);
  }
});

  /**
   * GET /worlds/:worldId/intel/:intelId
   */
  router.get("/:worldId/intel/:intelId", requireWorldMember, async (req, res, next) => {
    try {
      const { worldId, intelId } = req.params;
      const intel = intelStore.getIntel(worldId, intelId);
      if (!intel) return bad(res, "Intel not found", 404);
      return ok(res, { worldId, intelId, intel });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /worlds/:worldId/intel
   * Body:
   *  { title, kind, summary?, body?, tags?,
   *    scope?, actorId?, visibility?, restricted?,
   *    discoveredAt?, discoveredByActorId? }
   */
  router.post("/:worldId/intel", requireWorldMember, async (req, res, next) => {
    try {
      const anyReq = req as any;
      const { worldId } = req.params;
      await requireIntelWriteAccess(deps, anyReq, worldId);

      const title = cleanStr(req.body?.title);
      if (!title) return bad(res, "Missing title");

      const kind = cleanStr(req.body?.kind);
      if (!kind) return bad(res, "Missing kind");

      const scope = normalizeScope(req.body?.scope);
      const actorId = cleanStr(req.body?.actorId) || undefined;

      const createdBy = getSessionUserId(anyReq) ?? undefined;

      const created = intelStore.createIntel({
        worldId,
        title,
        kind: kind as any,

        summary: req.body?.summary ?? undefined,
        body: req.body?.body ?? undefined,
        tags: Array.isArray(req.body?.tags) ? req.body.tags : undefined,

        scope,
        actorId,

        visibility: req.body?.visibility ?? undefined,
        restricted: Array.isArray(req.body?.restricted) ? req.body.restricted : undefined,

        discoveredAt: toIsoOrNull(req.body?.discoveredAt ?? req.body?.discovered_at) ?? undefined,
        discoveredByActorId: cleanStr(req.body?.discoveredByActorId ?? req.body?.discovered_by_actor_id) || undefined,

        createdByVaultUserId: createdBy,
      });

      return ok(res, { worldId, intelId: created.id, id: created.id });
    } catch (err: any) {
      // normalizeScopeActor throws; treat as 400
      if (String(err?.message || "").includes("actorId is required")) {
        return bad(res, err.message, 400);
      }
      next(err);
    }
  });

  /**
   * PATCH /worlds/:worldId/intel/:intelId
   * Body: { patch: {...} } OR direct fields
   *
   * Supports snake_case aliases for discovered fields.
   */
  router.patch("/:worldId/intel/:intelId", requireWorldMember, async (req, res, next) => {
    try {
      const anyReq = req as any;
      const { worldId, intelId } = req.params;
      await requireIntelWriteAccess(deps, anyReq, worldId);

      const patch = (req.body?.patch ?? req.body ?? {}) as any;
      const updatedBy = getSessionUserId(anyReq) ?? undefined;

      // Accept snake_case aliases
      if ("discovered_at" in patch && !("discoveredAt" in patch)) patch.discoveredAt = patch.discovered_at;
      if ("discovered_by_actor_id" in patch && !("discoveredByActorId" in patch))
        patch.discoveredByActorId = patch.discovered_by_actor_id;

      // Normalize types
      if ("scope" in patch) patch.scope = normalizeScope(patch.scope);
      if ("actorId" in patch) patch.actorId = cleanStr(patch.actorId) || null;

      if ("title" in patch) patch.title = cleanStr(patch.title);
      if ("kind" in patch) patch.kind = cleanStr(patch.kind);

      if ("discoveredAt" in patch) patch.discoveredAt = toIsoOrNull(patch.discoveredAt);
      if ("discoveredByActorId" in patch) patch.discoveredByActorId = cleanStr(patch.discoveredByActorId) || null;

      // Normalize list fields
      if ("tags" in patch && patch.tags != null && !Array.isArray(patch.tags)) return bad(res, "tags must be an array", 400);
      if ("restricted" in patch && patch.restricted != null && !Array.isArray(patch.restricted))
        return bad(res, "restricted must be an array", 400);

      // remove snake_case keys to avoid accidental mismatch
      delete patch.discovered_at;
      delete patch.discovered_by_actor_id;

      const out = intelStore.updateIntel({
        worldId,
        id: intelId,
        patch,
        updatedByVaultUserId: updatedBy,
      });

      if (!out.ok) return bad(res, out.error ?? "Update failed", 400);
      return ok(res, { worldId, intelId });
    } catch (err: any) {
      if (String(err?.message || "").includes("actorId is required")) {
        return bad(res, err.message, 400);
      }
      next(err);
    }
  });



  /**
   * POST /worlds/:worldId/intel/:intelId/discovered
   * Body: { discoveredAt?, discoveredByActorId? }
   */
  router.post("/:worldId/intel/:intelId/discovered", requireWorldMember, async (req, res, next) => {
    try {
      const anyReq = req as any;
      const { worldId, intelId } = req.params;
      await requireIntelWriteAccess(deps, anyReq, worldId);

      const out = intelStore.markDiscovered({
        worldId,
        id: intelId,
        discoveredAt: toIsoOrNull(req.body?.discoveredAt ?? req.body?.discovered_at) ?? undefined,
        discoveredByActorId: cleanStr(req.body?.discoveredByActorId ?? req.body?.discovered_by_actor_id) || null,
        updatedByVaultUserId: getSessionUserId(anyReq) ?? undefined,
      });

      if (!out.ok) return bad(res, out.error ?? "Update failed", 400);
      return ok(res, { worldId, intelId });
    } catch (err) {
      next(err);
    }
  });

  /**
   * DELETE /worlds/:worldId/intel/:intelId
   * soft delete
   */
  router.delete("/:worldId/intel/:intelId", requireWorldMember, async (req, res, next) => {
    try {
      const anyReq = req as any;
      const { worldId, intelId } = req.params;
      await requireIntelWriteAccess(deps, anyReq, worldId);

      intelStore.deleteIntel({
        worldId,
        id: intelId,
        updatedByVaultUserId: getSessionUserId(anyReq) ?? undefined,
      });

      return ok(res, { worldId, intelId });
    } catch (err) {
      next(err);
    }
  });

  /* =========================================================
   * ATTACHMENTS
   * ========================================================= */
    /**
     * POST /worlds/:worldId/intel/:intelId/upload
     * multipart/form-data: file=<image>, caption?, sortOrder?
     *
     * Saves file -> creates Media row -> attaches to intel -> returns ids.
     */

    // safeId + extFromMime assumed to exist
    // upload = multer(...).single("file") assumed to exist

    router.post(
    "/:worldId/intel/:intelId/upload",
    requireWorldMember,
    upload.single("file"),
    async (req, res, next) => {
        try {
        const anyReq = req as any;
        const { worldId: worldIdRaw, intelId } = req.params;

        await requireIntelWriteAccess(deps, anyReq, worldIdRaw);

        if (!deps.foundryDataRoot) return bad(res, "FOUNDRY_DATA_ROOT not configured", 500);
        if (!req.file) return bad(res, "Missing file", 400);

        // Ensure intel exists (FK safety)
        const intel = intelStore.getIntel(worldIdRaw, intelId);
        if (!intel) return bad(res, "Intel not found", 404);

        // Use safeId ONLY for filesystem folder naming
        const worldDir = safeId(worldIdRaw);

        // Save file
        const ext = extFromMime(req.file.mimetype); // e.g. "webp" | "png" | "jpg"
        const baseName = `intel-${intelId}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${ext}`;

        const relDir = path.join("worlds", worldDir, "vaulthero", "uploads", "intel");
        const absDir = path.join(deps.foundryDataRoot, relDir);
        await fs.mkdir(absDir, { recursive: true });

        const absFile = path.join(absDir, baseName);
        await fs.writeFile(absFile, req.file.buffer);

        const mediaRelPath = path.join(relDir, baseName).replace(/\\/g, "/");
        const url = `/media/${mediaRelPath}`;

        const createdBy = getSessionUserId(anyReq) ?? null;

        // Create media_objects row
        const mediaOut = intelStore.createMedia({
            worldId: worldIdRaw,              // IMPORTANT: DB world_id must match intel.world_id
            kind: "intel",
            filename: req.file.originalname || baseName,
            mimeType: req.file.mimetype || null,
            byteSize: req.file.size ?? null,
            storage: "vault",
            path: mediaRelPath,
            createdByVaultUserId: createdBy,
        });

        const mediaId = mediaOut.id;

        // Attach it
        const caption = req.body?.caption ?? undefined;
        const sortOrder = req.body?.sortOrder != null ? toInt(req.body.sortOrder, 0) : undefined;

        const attachOut = intelStore.attachMedia({
            worldId: worldIdRaw,
            intelId,
            mediaId,
            caption,
            sortOrder,
        });

        return ok(res, {
            worldId: worldIdRaw,
            intelId,
            mediaId,
            attachmentId: attachOut.id,
            path: mediaRelPath,
            url,
            media: mediaOut.media, // may be null if you keep the optional SELECT
        });
        } catch (err) {
        next(err);
        }
    }
    );
  /**
   * GET /worlds/:worldId/intel/:intelId/attachments
   */
  router.get("/:worldId/intel/:intelId/attachments", requireWorldMember, async (req, res, next) => {
    try {
      const { worldId, intelId } = req.params;
      const attachments = intelStore.listAttachments({ worldId, intelId });
      return ok(res, { worldId, intelId, count: attachments.length, attachments });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /worlds/:worldId/intel/:intelId/attachments
   * Body: { mediaId, caption?, sortOrder? }
   */
  router.post("/:worldId/intel/:intelId/attachments", requireWorldMember, async (req, res, next) => {
    try {
      const anyReq = req as any;
      const { worldId, intelId } = req.params;
      await requireIntelWriteAccess(deps, anyReq, worldId);

      const mediaId = cleanStr(req.body?.mediaId);
      if (!mediaId) return bad(res, "Missing mediaId");

      const created = intelStore.attachMedia({
        worldId,
        intelId,
        mediaId,
        caption: req.body?.caption ?? undefined,
        sortOrder: req.body?.sortOrder != null ? toInt(req.body.sortOrder, 0) : undefined,
      });

      return ok(res, { worldId, intelId, attachmentId: created.id, id: created.id });
    } catch (err) {
      next(err);
    }
  });

  /**
   * PATCH /worlds/:worldId/intel-attachments/:attachmentId
   * Body: { patch: { caption?, sortOrder? } } OR direct fields
   */
  router.patch("/:worldId/intel-attachments/:attachmentId", requireWorldMember, async (req, res, next) => {
    try {
      const anyReq = req as any;
      const { worldId, attachmentId } = req.params;
      await requireIntelWriteAccess(deps, anyReq, worldId);

      const patch = (req.body?.patch ?? req.body ?? {}) as any;

      const out = intelStore.updateAttachment({
        worldId,
        id: attachmentId,
        patch: {
          ...(Object.prototype.hasOwnProperty.call(patch, "caption") ? { caption: patch.caption ?? null } : null),
          ...(Object.prototype.hasOwnProperty.call(patch, "sortOrder") ? { sortOrder: toInt(patch.sortOrder, 0) } : null),
        } as any,
      });

      if (!out.ok) return bad(res, out.error ?? "Update failed", 400);
      return ok(res, { worldId, attachmentId });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /worlds/:worldId/intel/:intelId/attachments/reorder
   * Body: { orderedIds: string[] }
   */
  router.post("/:worldId/intel/:intelId/attachments/reorder", requireWorldMember, async (req, res, next) => {
    try {
      const anyReq = req as any;
      const { worldId, intelId } = req.params;
      await requireIntelWriteAccess(deps, anyReq, worldId);

      const orderedIds = Array.isArray(req.body?.orderedIds) ? req.body.orderedIds : null;
      if (!orderedIds) return bad(res, "orderedIds must be an array");

      const out = intelStore.reorderAttachments({ worldId, intelId, orderedIds });
      return ok(res, { worldId, intelId, ...out });
    } catch (err) {
      next(err);
    }
  });

  /**
   * DELETE /worlds/:worldId/intel-attachments/:attachmentId
   * soft delete attachment row
   */
  router.delete("/:worldId/intel-attachments/:attachmentId", requireWorldMember, async (req, res, next) => {
    try {
      const anyReq = req as any;
      const { worldId, attachmentId } = req.params;
      await requireIntelWriteAccess(deps, anyReq, worldId);

      const out = intelStore.detachMedia({ worldId, attachmentId });
      return ok(res, { worldId, attachmentId, ...out });
    } catch (err) {
      next(err);
    }
  });

  return router;
}