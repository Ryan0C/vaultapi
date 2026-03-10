import { Router } from "express";
import type { CreateAppDeps } from "../app.js";
import { makeRequireWorldMember } from "../middleware/authz.js";

type ImportsWorldStore = {
  createImport(
    worldId: string,
    input: {
      type: string;
      entityType?: string;
      entityId?: string | null;
      payload: any;
      source?: string;
      meta?: Record<string, any>;
      requestId?: string;
    }
  ): Promise<{ ok: true; id: string; envelope: any } | { ok: false; error: string }>;

  readImport(worldId: string, importId: string): Promise<any | null>;
  readAck(worldId: string, importId: string): Promise<any | null>;
  getImportStatus(worldId: string, importId: string): Promise<any>;
  listInbox(worldId: string): Promise<any[]>;
  listAcks(worldId: string): Promise<any[]>;
};

function asParamString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return String(value[0] ?? "").trim();
  return String(value ?? "").trim();
}

export function makeImportsRouter(deps: CreateAppDeps) {
  const router = Router();

  const { authStore, importsStore } = deps as unknown as CreateAppDeps & {
    importsStore: ImportsWorldStore;
  };

  const requireWorldMember = makeRequireWorldMember(authStore);

  /**
   * GET /worlds/:worldId/imports
   * List inbox entries (newest first)
   */
  router.get("/:worldId/imports", requireWorldMember, async (req, res, next) => {
    try {
      const worldId = asParamString(req.params.worldId);
      const imports = await importsStore.listInbox(worldId);

      return res.json({
        ok: true,
        worldId,
        count: imports.length,
        imports,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /worlds/:worldId/imports/acks
   * List ack entries (newest first)
   */
  router.get("/:worldId/imports/acks", requireWorldMember, async (req, res, next) => {
    try {
      const worldId = asParamString(req.params.worldId);
      const acks = await importsStore.listAcks(worldId);

      return res.json({
        ok: true,
        worldId,
        count: acks.length,
        acks,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /worlds/:worldId/imports
   * Create a new import envelope in inbox
   *
   * Body:
   * {
   *   type: string,
   *   entityType?: string,
   *   entityId?: string | null,
   *   payload: any,
   *   source?: string,
   *   meta?: Record<string, any>,
   *   requestId?: string
   * }
   */
  router.post("/:worldId/imports", requireWorldMember, async (req, res, next) => {
    try {
      const worldId = asParamString(req.params.worldId);

      deps.logger.info("imports.create.request", {
        worldId,
        body: req.body,
      });

      const type = String(req.body?.type ?? "").trim();
      const payload = req.body?.payload;

      if (!type) {
        return res.status(400).json({ ok: false, error: "Missing type" });
      }

      if (payload == null) {
        return res.status(400).json({ ok: false, error: "Missing payload" });
      }

      const result = await importsStore.createImport(worldId, {
        type,
        entityType:
          req.body?.entityType != null ? String(req.body.entityType) : undefined,
        entityId:
          req.body?.entityId != null ? String(req.body.entityId) : null,
        payload,
        source:
          req.body?.source != null ? String(req.body.source) : undefined,
        meta:
          req.body?.meta && typeof req.body.meta === "object" ? req.body.meta : undefined,
        requestId:
          req.body?.requestId != null ? String(req.body.requestId) : undefined,
      });

      if (!result.ok) {
        return res.status(400).json({
          ok: false,
          error: result.error,
        });
      }

      return res.status(202).json({
        ok: true,
        worldId,
        importId: result.id,
        status: "pending",
        envelope: result.envelope,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /worlds/:worldId/imports/:importId
   * Read raw inbox envelope
   */
  router.get("/:worldId/imports/:importId", requireWorldMember, async (req, res, next) => {
    try {
      const worldId = asParamString(req.params.worldId);
      const importId = asParamString(req.params.importId);

      const envelope = await importsStore.readImport(worldId, importId);
      if (!envelope) {
        return res.status(404).json({ ok: false, error: "Import not found" });
      }

      return res.json({
        ok: true,
        worldId,
        importId,
        envelope,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /worlds/:worldId/imports/:importId/ack
   * Read ack file directly
   */
  router.get("/:worldId/imports/:importId/ack", requireWorldMember, async (req, res, next) => {
    try {
      const worldId = asParamString(req.params.worldId);
      const importId = asParamString(req.params.importId);

      const ack = await importsStore.readAck(worldId, importId);
      if (!ack) {
        return res.status(404).json({ ok: false, error: "Import ack not found" });
      }

      return res.json({
        ok: true,
        worldId,
        importId,
        ack,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /worlds/:worldId/imports/:importId/status
   * Combined status view:
   * - pending if inbox exists but no ack yet
   * - applied / failed if ack exists
   */
  router.get("/:worldId/imports/:importId/status", requireWorldMember, async (req, res, next) => {
    try {
      const worldId = asParamString(req.params.worldId);
      const importId = asParamString(req.params.importId);

      const status = await importsStore.getImportStatus(worldId, importId);

      return res.json({
        ok: true,
        worldId,
        importId,
        status,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
