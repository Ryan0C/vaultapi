// @ts-nocheck
import { Router } from "express";
import type { CreateAppDeps } from "../app.js";
import { makeRequireWorldMember } from "../middleware/authz.js";
import { forbidden, unauthorized } from "../utils/errors.js";
import { questStore } from "../stores/questStore.js";
import { db } from "../services/db.js";

function isApiKeySuperuser(req: any): boolean {
  return req.auth?.kind === "apiKey" && !!req.auth?.superuser;
}

function getSessionUserId(req: any): string | null {
  return req.session?.userId ?? null;
}

async function requireQuestWriteAccess(deps: CreateAppDeps, req: any, worldId: string) {
  // Superuser api key can do anything
  if (isApiKeySuperuser(req)) return { isDm: true };

  const userId = getSessionUserId(req);
  if (!userId) throw unauthorized("Login required");

  const isDm = deps.authStore.isWorldDm(worldId, userId);
  if (isDm) return { isDm: true };

  // Default DM-only (tight). You can later add a policy switch like commands.
  throw forbidden("Quests are DM-only for this world");
}

function cleanStr(v: any) {
  const s = String(v ?? "").trim();
  return s || "";
}

function toInt(v: any, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function toBool01(v: any, fallback = 0) {
  if (v === true) return 1;
  if (v === false) return 0;
  const n = Number(v);
  if (n === 1) return 1;
  if (n === 0) return 0;
  return fallback;
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

function parseRestricted(json: any): { actorIds: string[]; userIds: string[] } {
  try {
    const o = JSON.parse(json ?? "null");
    return {
      actorIds: Array.isArray(o?.actorIds) ? o.actorIds.map(String) : [],
      userIds: Array.isArray(o?.userIds) ? o.userIds.map(String) : [],
    };
  } catch {
    return { actorIds: [], userIds: [] };
  }
}

function normalizeRestricted(input: any): any {
  if (input == null) return null;
  if (Array.isArray(input)) {
    // legacy: treat as actorIds
    return { actorIds: input.map(String), userIds: [] };
  }
  if (typeof input === "object") {
    return {
      actorIds: Array.isArray((input as any).actorIds) ? (input as any).actorIds.map(String) : [],
      userIds: Array.isArray((input as any).userIds) ? (input as any).userIds.map(String) : [],
    };
  }
  return null;
}

export function makeQuestRouter(deps: CreateAppDeps) {
  const router = Router();
  const requireWorldMember = makeRequireWorldMember(deps.authStore);

  /* =========================================================
   * QUESTS
   * ========================================================= */

    /**
     * GET /worlds/:worldId/quests/assigned
     * Query: ?scope=party|actor&actorId=...
     *
     * Returns quests that have assignments matching scope (+ actorId if scope=actor).
     * Players only see quests they’re allowed to see by visibility.
     */
    router.get("/:worldId/quests/assigned", requireWorldMember, async (req, res, next) => {
    try {
        const anyReq = req as any;
        const { worldId } = req.params;

        const scope = (cleanStr(req.query?.scope) || "party") as "party" | "actor";
        const actorId = cleanStr(req.query?.actorId);

        const userId = getSessionUserId(anyReq);
        const isDm = !!(userId && deps.authStore.isWorldDm(worldId, userId));

        const where: string[] = [
        `a.world_id=@worldId`,
        `a.deleted_at IS NULL`,
        `q.deleted_at IS NULL`,
        ];
        const params: any = { worldId };

        if (scope === "actor") {
        if (!actorId) return bad(res, "actorId is required when scope=actor");
        where.push(`a.scope='actor' AND a.actor_id=@actorId`);
        params.actorId = actorId;
        } else {
        where.push(`a.scope='party'`);
        }

        // visibility rules for non-DM
        if (!isDm) {
        where.push(`q.visibility IN ('players','restricted')`);
        }

        const sql = `
        SELECT
            a.id as assignment_id,
            a.scope as assignment_scope,
            a.actor_id as assignment_actor_id,
            a.assigned_at,
            a.time_status,
            a.expected_complete_at,
            a.duration_seconds,
            q.reward_json,
            q.id as quest_id,
            q.title,
            q.summary,
            q.body,
            q.category,
            q.status,
            q.priority,
            q.tags_json,
            q.visibility,
            q.restricted_json,
            q.available_from,
            q.available_until,
            q.auto_fail_on_expire,
            q.created_at,
            q.updated_at
        FROM quest_assignments a
        JOIN quests q ON q.id = a.quest_id
        WHERE ${where.join(" AND ")}
        ORDER BY a.assigned_at DESC
        `;

        const raw = db.prepare(sql).all(params) as any[];

        // Enforce restricted membership in JS (works without json1)
        let out = raw;

        if (!isDm) {
        out = raw.filter((r) => {
            const vis = String(r.visibility ?? "").toLowerCase();
            if (vis === "players") return true;
            if (vis !== "restricted") return false;

            // restricted requires a viewer context
            const restricted = parseRestricted(r.restricted_json);

            // If scope=actor we can check actorIds; always check userIds too
            const okByActor = actorId ? restricted.actorIds.includes(String(actorId)) : false;
            const okByUser = userId ? restricted.userIds.includes(String(userId)) : false;

            return okByActor || okByUser;
        });
        }

        return ok(res, {
        worldId,
        count: out.length,
        quests: out.map((r) => ({
            assignmentId: r.assignment_id,
            assignment: {
            id: r.assignment_id,
            scope: r.assignment_scope,
            actorId: r.assignment_actor_id,
            assignedAt: r.assigned_at,
            timeStatus: r.time_status,
            expectedCompleteAt: r.expected_complete_at,
            durationSeconds: r.duration_seconds,
            },
            quest: {
            id: r.quest_id,
            title: r.title,
            summary: r.summary,
            body: r.body,
            status: r.status,
            reward: (() => { try { return JSON.parse(r.reward_json ?? "null"); } catch { return null; } })(),
            priority: r.priority,
            tags: (() => { try { return JSON.parse(r.tags_json ?? "[]"); } catch { return []; } })(),
            visibility: r.visibility,
            restricted: (() => { // ✅ FIXED (was reading req.body)
                try { return JSON.parse(r.restricted_json ?? "null"); } catch { return null; }
            })(),
            category: r.category ?? null,
            availableFrom: r.available_from,
            availableUntil: r.available_until,
            autoFailOnExpire: !!r.auto_fail_on_expire,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
            },
        })),
        });
    } catch (err) {
        next(err);
    }
    });

  /**
   * GET /worlds/:worldId/quests
   * Query: ?status=
   */
  router.get("/:worldId/quests", requireWorldMember, async (req, res, next) => {
    try {
      const { worldId } = req.params;
      const status = cleanStr(req.query?.status);
      const quests = questStore.listQuests({
        worldId,
        status: status ? (status as any) : undefined
      });
      
      return ok(res, { worldId, count: quests.length, quests });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /worlds/:worldId/quests/:questId
   */
  router.get("/:worldId/quests/:questId", requireWorldMember, async (req, res, next) => {
    try {
      const { worldId, questId } = req.params;
      const quest = questStore.getQuest(worldId, questId);
      if (!quest) return bad(res, "Quest not found", 404);
      return ok(res, { worldId, questId, quest });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /worlds/:worldId/quests
   * Body: { title, summary?, body?, templateId?, tags?, visibility?, restricted?,
   *         availableFrom?, availableUntil?, autoFailOnExpire? }
   */
    router.post("/:worldId/quests", requireWorldMember, async (req, res, next) => {
    try {
        const anyReq = req as any;
        const { worldId } = req.params;
        await requireQuestWriteAccess(deps, anyReq, worldId);

        const title = cleanStr(req.body?.title);
        if (!title) return bad(res, "Missing title");

        const createdBy = getSessionUserId(anyReq) ?? undefined;

        const created = questStore.createQuest({
        worldId,
        title,
        summary: req.body?.summary ?? undefined,
        body: req.body?.body ?? undefined,
        templateId: req.body?.templateId ?? undefined,

        category: cleanStr(req.body?.category) || null,  // ✅ NEW
        reward: req.body?.reward ?? null,                // ✅ NEW

        tags: Array.isArray(req.body?.tags) ? req.body.tags : undefined,
        visibility: req.body?.visibility ?? undefined,
        restricted: normalizeRestricted(req.body?.restricted) ?? undefined,

        // timers / window
        availableFrom: toIsoOrNull(req.body?.availableFrom ?? req.body?.available_from),
        availableUntil: toIsoOrNull(req.body?.availableUntil ?? req.body?.available_until),
        autoFailOnExpire: toBool01(req.body?.autoFailOnExpire ?? req.body?.auto_fail_on_expire, 0) === 1,

        createdByVaultUserId: createdBy,
        });

        return ok(res, { worldId, questId: created.id, id: created.id });
    } catch (err) {
        next(err);
    }
    });

  /**
   * PATCH /worlds/:worldId/quests/:questId
   * Body: { patch: {...} } OR direct fields
   */
    router.patch("/:worldId/quests/:questId", requireWorldMember, async (req, res, next) => {
    try {
        const anyReq = req as any;
        const { worldId, questId } = req.params;
        await requireQuestWriteAccess(deps, anyReq, worldId);

        const patch = (req.body?.patch ?? req.body ?? {}) as any;
        const updatedBy = getSessionUserId(anyReq) ?? undefined;

        // Accept snake_case inputs, normalize to camelCase expected by questStore.updateQuest
        if ("available_from" in patch && !("availableFrom" in patch)) patch.availableFrom = patch.available_from;
        if ("available_until" in patch && !("availableUntil" in patch)) patch.availableUntil = patch.available_until;
        if ("auto_fail_on_expire" in patch && !("autoFailOnExpire" in patch)) patch.autoFailOnExpire = patch.auto_fail_on_expire;

        // Normalize types
        if ("availableFrom" in patch) patch.availableFrom = toIsoOrNull(patch.availableFrom);
        if ("availableUntil" in patch) patch.availableUntil = toIsoOrNull(patch.availableUntil);
        if ("autoFailOnExpire" in patch) patch.autoFailOnExpire = toBool01(patch.autoFailOnExpire, 0) === 1;

        // normalize reward
        if ("reward_json" in patch && !("reward" in patch)) patch.reward = patch.reward_json;

        // normalize category (optional; either works)
        if ("category" in patch) patch.category = cleanStr(patch.category) || null;

        // normalize restricted (support legacy array OR object)
        if ("restricted" in patch) patch.restricted = normalizeRestricted(patch.restricted);

        // normalize tags_json -> tags
        if ("tags_json" in patch && !("tags" in patch)) {
        try { patch.tags = JSON.parse(patch.tags_json ?? "[]"); } catch { patch.tags = []; }
        }


        // (optional) drop snake_case keys to avoid accidental DB-column patch attempts
        delete patch.available_from;
        delete patch.available_until;
        delete patch.auto_fail_on_expire;
        delete patch.reward_json;
        delete patch.tags_json;

        const out = questStore.updateQuest({
        worldId,
        id: questId,
        patch,
        updatedByVaultUserId: updatedBy,
        });

        if (!out.ok) return bad(res, out.error ?? "Update failed", 400);
        return ok(res, { worldId, questId });
    } catch (err) {
        next(err);
    }
    });

  /**
   * DELETE /worlds/:worldId/quests/:questId
   * soft delete
   */
  router.delete("/:worldId/quests/:questId", requireWorldMember, async (req, res, next) => {
    try {
      const anyReq = req as any;
      const { worldId, questId } = req.params;
      await requireQuestWriteAccess(deps, anyReq, worldId);

      questStore.deleteQuest(worldId, questId);
      return ok(res, { worldId, questId });
    } catch (err) {
      next(err);
    }
  });

  /* =========================================================
   * OBJECTIVES (definition)
   * ========================================================= */

  /**
   * GET /worlds/:worldId/quests/:questId/objectives
   */
  router.get("/:worldId/quests/:questId/objectives", requireWorldMember, async (req, res, next) => {
    try {
      const { worldId, questId } = req.params;
      const objectives = questStore.listObjectives({ worldId, questId });
      return ok(res, { worldId, questId, count: objectives.length, objectives });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /worlds/:worldId/quests/:questId/objectives
   */
  router.post("/:worldId/quests/:questId/objectives", requireWorldMember, async (req, res, next) => {
    try {
      const anyReq = req as any;
      const { worldId, questId } = req.params;
      await requireQuestWriteAccess(deps, anyReq, worldId);

      const title = cleanStr(req.body?.title);
      if (!title) return bad(res, "Missing title");

      const created = questStore.createObjective({
        worldId,
        questId,
        title,
        description: req.body?.description ?? undefined,
        key: req.body?.key ?? undefined,
        sortOrder: toInt(req.body?.sortOrder, 0),
        required: req.body?.required !== false
      });

      return ok(res, { worldId, questId, objectiveId: created.id, id: created.id });
    } catch (err) {
      next(err);
    }
  });

  /**
   * PATCH /worlds/:worldId/objectives/:objectiveId
   */
  router.patch("/:worldId/objectives/:objectiveId", requireWorldMember, async (req, res, next) => {
    try {
      const anyReq = req as any;
      const { worldId, objectiveId } = req.params;
      await requireQuestWriteAccess(deps, anyReq, worldId);

      const patch = (req.body?.patch ?? req.body ?? {}) as any;
      const out = questStore.updateObjective({
        worldId,
        id: objectiveId,
        patch
      });

      if (!out.ok) return bad(res, out.error ?? "Update failed", 400);
      return ok(res, { worldId, objectiveId });
    } catch (err) {
      next(err);
    }
  });

  /**
   * DELETE /worlds/:worldId/objectives/:objectiveId
   */
  router.delete("/:worldId/objectives/:objectiveId", requireWorldMember, async (req, res, next) => {
    try {
      const anyReq = req as any;
      const { worldId, objectiveId } = req.params;
      await requireQuestWriteAccess(deps, anyReq, worldId);

      questStore.deleteObjective({ worldId, id: objectiveId });
      return ok(res, { worldId, objectiveId });
    } catch (err) {
      next(err);
    }
  });

  /* =========================================================
   * ASSIGNMENTS + TIMERS
   * (You can flesh out questStore assignment CRUD next;
   *  for now these endpoints assume you’ll add minimal helpers.)
   * ========================================================= */

    router.post("/:worldId/assignments/:assignmentId/timer/pause", requireWorldMember, async (req,res,next)=>{
    try {
        const anyReq = req as any;
        const { worldId, assignmentId } = req.params;
        await requireQuestWriteAccess(deps, anyReq, worldId);

        const out = questStore.pauseTimedAssignment({ worldId, assignmentId });
        return ok(res, { worldId, assignmentId, ...out });
    } catch (err) { next(err); }
    });

    router.post("/:worldId/assignments/:assignmentId/timer/resume", requireWorldMember, async (req,res,next)=>{
    try {
        const anyReq = req as any;
        const { worldId, assignmentId } = req.params;
        await requireQuestWriteAccess(deps, anyReq, worldId);

        const out = questStore.resumeTimedAssignment({ worldId, assignmentId });
        if (!out.ok) return bad(res, out.error ?? "Resume failed", 400);
        return ok(res, { worldId, assignmentId, ...out });
    } catch (err) { next(err); }
    });

  /**
   * POST /worlds/:worldId/quests/:questId/assign
   * Body: { scope:'party'|'actor', actorId?, assignedAt?, durationSeconds? }
   *
   * NOTE: questStore does not yet include createAssignment(). Add it, then wire here.
   */
    router.post("/:worldId/quests/:questId/assign", requireWorldMember, async (req, res, next) => {
    try {
        const anyReq = req as any;
        const { worldId, questId } = req.params;
        await requireQuestWriteAccess(deps, anyReq, worldId);

        const scope = (cleanStr(req.body?.scope) || "party") as "party" | "actor";
        const actorId = cleanStr(req.body?.actorId) || null;

        const durationSeconds =
        req.body?.durationSeconds != null ? toInt(req.body.durationSeconds, 0) : null;

        const created = questStore.createAssignment({
        worldId,
        questId,
        scope,
        actorId,
        assignedByVaultUserId: getSessionUserId(anyReq) ?? null,

        // optional timer pre-seed (if you ever support it from UI)
        durationSeconds,
        startedAt: null,
        timeStatus: "idle",
        });

        return ok(res, { worldId, questId, assignmentId: created.id, id: created.id });
    } catch (err) {
        next(err);
    }
    });

  /**
   * POST /worlds/:worldId/assignments/:assignmentId/timer/start
   * Body: { durationSeconds }
   */
  router.post("/:worldId/assignments/:assignmentId/timer/start", requireWorldMember, async (req, res, next) => {
    try {
      const anyReq = req as any;
      const { worldId, assignmentId } = req.params;
      await requireQuestWriteAccess(deps, anyReq, worldId);

      const durationSeconds = toInt(req.body?.durationSeconds, 0);
      if (!durationSeconds || durationSeconds < 1) return bad(res, "durationSeconds must be >= 1");

      const out = questStore.startTimedAssignment({
        worldId,
        assignmentId,
        durationSeconds
      });

      return ok(res, { worldId, assignmentId, ...out });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /worlds/:worldId/assignments/:assignmentId/timer/complete
   */
  router.post("/:worldId/assignments/:assignmentId/timer/complete", requireWorldMember, async (req, res, next) => {
    try {
      const anyReq = req as any;
      const { worldId, assignmentId } = req.params;
      await requireQuestWriteAccess(deps, anyReq, worldId);

      const out = questStore.completeTimedAssignment({ worldId, assignmentId });
      return ok(res, { worldId, assignmentId, ...out });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /worlds/:worldId/assignments/timer/expire
   * Sweeps overdue assignments -> time_status='expired'
   */
  router.post("/:worldId/assignments/timer/expire", requireWorldMember, async (req, res, next) => {
    try {
      const anyReq = req as any;
      const { worldId } = req.params;
      await requireQuestWriteAccess(deps, anyReq, worldId);

      const out = questStore.expireOverdueAssignments(worldId);
      return ok(res, { worldId, ...out });
    } catch (err) {
      next(err);
    }
  });

  /* =========================================================
   * OBJECTIVE STATE (per assignment)
   * ========================================================= */

  /**
   * GET /worlds/:worldId/assignments/:assignmentId/objectives
   * Returns objectives + state for the assignment’s quest
   * Query: ?questId=...
   *
   * (You can also implement a lookup assignment->quest in store later.)
   */
    router.get("/:worldId/assignments/:assignmentId/objectives", requireWorldMember, async (req, res, next) => {
    try {
        const { worldId, assignmentId } = req.params;

        const assignment = questStore.getAssignment({ worldId, assignmentId });
        if (!assignment) return bad(res, "Assignment not found", 404);

        const questId = assignment.questId;
        const rows = questStore.getObjectivesWithState({ worldId, questId, assignmentId });

        return ok(res, { worldId, questId, assignmentId, count: rows.length, rows });
    } catch (err) {
        next(err);
    }
    });

  /**
   * PATCH /worlds/:worldId/assignments/:assignmentId/objectives/:objectiveId/state
   * Body: { patch: { status?, progressCurrent?, progressMax?, note? } }
   */
    router.patch("/:worldId/assignments/:assignmentId/objectives/:objectiveId/state", requireWorldMember, async (req, res, next) => {
    try {
        const anyReq = req as any;
        const { worldId, assignmentId, objectiveId } = req.params;
        await requireQuestWriteAccess(deps, anyReq, worldId);

        const patch = (req.body?.patch ?? req.body ?? {}) as any;

        const out = questStore.updateObjectiveState({
        worldId,
        assignmentId,
        objectiveId,
        patch,
        });

        if (!out.ok) return bad(res, out.error ?? "Update failed", 400);

        // recompute without needing questId in body
        const assignment = questStore.getAssignment({ worldId, assignmentId });
        const recompute = assignment
        ? questStore.recomputeQuestStatusFromObjectives({ worldId, questId: assignment.questId, assignmentId })
        : null;

        return ok(res, { worldId, assignmentId, objectiveId, recompute });
    } catch (err) {
        next(err);
    }
    });

  /* =========================================================
   * LEGACY LINKS (quest_links parent/child)
   * ========================================================= */

  /**
   * POST /worlds/:worldId/quests/:parentQuestId/children
   * Body: { childQuestId, sortOrder? }
   */
  router.post("/:worldId/quests/:parentQuestId/children", requireWorldMember, async (req, res, next) => {
    try {
      const anyReq = req as any;
      const { worldId, parentQuestId } = req.params;
      await requireQuestWriteAccess(deps, anyReq, worldId);

      const childQuestId = cleanStr(req.body?.childQuestId);
      if (!childQuestId) return bad(res, "Missing childQuestId");

      const out = questStore.linkQuest({
        worldId,
        parentQuestId,
        childQuestId,
        sortOrder: toInt(req.body?.sortOrder, 0)
      });

      if (!out.ok) return bad(res, out.error ?? "Link failed", 400);
      return ok(res, { worldId, parentQuestId, childQuestId, linkId: out.id });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /worlds/:worldId/quests/:parentQuestId/children
   */
  router.get("/:worldId/quests/:parentQuestId/children", requireWorldMember, async (req, res, next) => {
    try {
      const { worldId, parentQuestId } = req.params;
      const edges = questStore.listChildren({ worldId, parentQuestId });
      return ok(res, { worldId, parentQuestId, count: edges.length, edges });
    } catch (err) {
      next(err);
    }
  });

  /**
   * DELETE /worlds/:worldId/quests/:parentQuestId/children/:childQuestId
   */
  router.delete("/:worldId/quests/:parentQuestId/children/:childQuestId", requireWorldMember, async (req, res, next) => {
    try {
      const anyReq = req as any;
      const { worldId, parentQuestId, childQuestId } = req.params;
      await requireQuestWriteAccess(deps, anyReq, worldId);

      const out = questStore.unlinkQuest({ worldId, parentQuestId, childQuestId });
      return ok(res, { worldId, parentQuestId, childQuestId, deleted: out.deleted });
    } catch (err) {
      next(err);
    }
  });

  /* =========================================================
   * VUE-FLOW QUEST CHAINS (quest_chains + nodes + edges)
   * These require questStore methods you likely haven’t added yet.
   * ========================================================= */

    router.get("/:worldId/quest-chains", requireWorldMember, async (req, res, next) => {
    try {
        const { worldId } = req.params;

        const chains = questStore.listChains(worldId);
        return ok(res, { worldId, count: chains.length, chains });
    } catch (err) {
        next(err);
    }
    });

  router.post("/:worldId/quest-chains", requireWorldMember, async (req, res, next) => {
    try {
      const anyReq = req as any;
      const { worldId } = req.params;
      await requireQuestWriteAccess(deps, anyReq, worldId);

      if (typeof (questStore as any).createChain !== "function") {
        return bad(res, "Quest chains not implemented in questStore yet", 501);
      }

      const title = cleanStr(req.body?.title);
      if (!title) return bad(res, "Missing title");

      const out = (questStore as any).createChain({
        worldId,
        title,
        summary: req.body?.summary ?? undefined,
        tags: Array.isArray(req.body?.tags) ? req.body.tags : undefined,
        createdByVaultUserId: getSessionUserId(anyReq) ?? undefined
      });

      return ok(res, { worldId, chainId: out.id, id: out.id });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:worldId/quest-chains/:chainId", requireWorldMember, async (req, res, next) => {
    try {
      const { worldId, chainId } = req.params;

      if (typeof (questStore as any).getChainGraph !== "function") {
        return bad(res, "Quest chains not implemented in questStore yet", 501);
      }

      const graph = (questStore as any).getChainGraph({ worldId, chainId });
      return ok(res, { worldId, chainId, graph });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/:worldId/quest-chains/:chainId", requireWorldMember, async (req, res, next) => {
    try {
      const anyReq = req as any;
      const { worldId, chainId } = req.params;
      await requireQuestWriteAccess(deps, anyReq, worldId);

      if (typeof (questStore as any).updateChain !== "function") {
        return bad(res, "Quest chains not implemented in questStore yet", 501);
      }

      const patch = (req.body?.patch ?? req.body ?? {}) as any;
      const out = (questStore as any).updateChain({
        worldId,
        chainId,
        patch,
        updatedByVaultUserId: getSessionUserId(anyReq) ?? undefined
      });

      if (!out.ok) return bad(res, out.error ?? "Update failed", 400);
      return ok(res, { worldId, chainId });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:worldId/quest-chains/:chainId", requireWorldMember, async (req, res, next) => {
    try {
      const anyReq = req as any;
      const { worldId, chainId } = req.params;
      await requireQuestWriteAccess(deps, anyReq, worldId);

      if (typeof (questStore as any).deleteChain !== "function") {
        return bad(res, "Quest chains not implemented in questStore yet", 501);
      }

      const out = (questStore as any).deleteChain({ worldId, chainId });
      return ok(res, { worldId, chainId, ...out });
    } catch (err) {
      next(err);
    }
  });

  /* =========================================================
   * QUEST PACKS (IMPORT / EXPORT)
   * ========================================================= */

  /**
   * GET /worlds/:worldId/quest-packs/export
   * Query:
   *  - includeObjectives=1 (default 1)
   *  - includeLinks=1 (default 0)
   *  - includeChains=1 (default 0)
   *
   * Returns a portable pack using "externalId" identifiers.
   */
  router.get("/:worldId/quest-packs/export", requireWorldMember, async (req, res, next) => {
    try {
      const anyReq = req as any;
      const { worldId } = req.params;

      // DM-only
      await requireQuestWriteAccess(deps, anyReq, worldId);

      const includeObjectives = toBool01(req.query?.includeObjectives, 1) === 1;
      const includeLinks = toBool01(req.query?.includeLinks, 0) === 1;
      const includeChains = toBool01(req.query?.includeChains, 0) === 1;

      const quests = questStore.listQuests({ worldId });

      // Use a stable externalId in export. For now, derive from quest.id.
      // Later you can store a real externalId field in DB if desired.
      const questExternalIdById = new Map<string, string>();
      for (const q of quests as any[]) questExternalIdById.set(q.id, String(q.id));

      const objectives: any[] = [];
      if (includeObjectives) {
        for (const q of quests as any[]) {
          const os = questStore.listObjectives({ worldId, questId: q.id });
          for (const o of os as any[]) {
            objectives.push({
              questExternalId: questExternalIdById.get(q.id),
              key: o.key ?? null,
              title: o.title,
              description: o.description ?? null,
              sortOrder: Number(o.sortOrder ?? 0),
              required: !!o.required,
            });
          }
        }
      }

      const links: any[] = [];
      if (includeLinks) {
        // There isn't a "list all links" helper. We'll approximate by scanning children for each quest.
        // This is OK for now; if it gets slow later, add a store method.
        for (const q of quests as any[]) {
          const children = questStore.listChildren({ worldId, parentQuestId: q.id });
          for (const e of children as any[]) {
            links.push({
              parentExternalId: questExternalIdById.get(e.parentQuestId),
              childExternalId: questExternalIdById.get(e.childQuestId),
              sortOrder: Number(e.sortOrder ?? 0),
            });
          }
        }
      }

      const chains: any[] = [];
      if (includeChains) {
        const cs = questStore.listChains(worldId) as any[];
        for (const c of cs) {
          const graph = questStore.getChainGraph({ worldId, chainId: c.id }) as any;

          chains.push({
            externalId: String(c.id),
            title: c.title,
            summary: c.summary ?? null,
            tags: c.tags ?? null,
            status: c.status ?? "draft",
            nodes: (graph.nodes ?? []).map((n: any) => ({
              questExternalId: questExternalIdById.get(n.questId) ?? String(n.questId),
              posX: Number(n.posX ?? 0),
              posY: Number(n.posY ?? 0),
              ui: n.ui ?? null,
              sortOrder: Number(n.sortOrder ?? 0),
            })),
            edges: (graph.edges ?? []).map((e: any) => ({
              fromQuestExternalId: questExternalIdById.get(e.fromQuestId) ?? String(e.fromQuestId),
              toQuestExternalId: questExternalIdById.get(e.toQuestId) ?? String(e.toQuestId),
              gateMode: e.gateMode ?? "all",
              condition: e.condition ?? null,
              autoAssign: !!e.autoAssign,
              delaySeconds: Number(e.delaySeconds ?? 0),
              ui: e.ui ?? null,
              sortOrder: Number(e.sortOrder ?? 0),
            })),
          });
        }
      }

      const pack = {
        format: "vaulthero.questPack",
        version: 1,
        meta: {
          title: `Quest pack export`,
          createdAt: new Date().toISOString(),
          sourceWorldId: worldId,
        },
        data: {
          quests: (quests as any[]).map((q) => ({
            externalId: questExternalIdById.get(q.id),
            title: q.title,
            summary: q.summary ?? null,
            body: q.body ?? null,
            category: q.category ?? null,     // ✅ NEW
            reward: q.reward ?? null,         // ✅ NEW
            status: q.status ?? "draft",
            priority: Number(q.priority ?? 0),
            tags: q.tags ?? null,
            visibility: q.visibility ?? "players",
            restricted: q.restricted ?? null,
            availableFrom: q.availableFrom ?? null,
            availableUntil: q.availableUntil ?? null,
            autoFailOnExpire: !!q.autoFailOnExpire,
          })),
          objectives,
          links,
          chains,
        },
      };

      return ok(res, { worldId, pack });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /worlds/:worldId/quest-packs/import
   * Body: { pack }
   *
   * Create-only import:
   * - Always creates new quests/objectives/links/chains.
   * - Returns idMap for quest externalIds.
   */
  router.post("/:worldId/quest-packs/import", requireWorldMember, async (req, res, next) => {
    try {
      const anyReq = req as any;
      const { worldId } = req.params;

      // DM-only
      await requireQuestWriteAccess(deps, anyReq, worldId);

      const pack = req.body?.pack ?? req.body;
      const data = pack?.data ?? null;

      const questsIn: any[] = Array.isArray(data?.quests) ? data.quests : [];
      const objectivesIn: any[] = Array.isArray(data?.objectives) ? data.objectives : [];
      const linksIn: any[] = Array.isArray(data?.links) ? data.links : [];
      const chainsIn: any[] = Array.isArray(data?.chains) ? data.chains : [];

      if (!questsIn.length) return bad(res, "Pack missing data.quests[]");

      const createdBy = getSessionUserId(anyReq) ?? undefined;

      // externalId -> new questId
      const idMap: Record<string, string> = {};

      let createdQuests = 0;
      for (let i = 0; i < questsIn.length; i++) {
        const q = questsIn[i] ?? {};
        const externalId = cleanStr(q.externalId) || `quest_${i + 1}`;

        const title = cleanStr(q.title);
        if (!title) return bad(res, `Quest missing title (externalId=${externalId})`);

        const created = questStore.createQuest({
          worldId,
          title,
          summary: q.summary ?? undefined,
          body: q.body ?? undefined,
          templateId: q.templateId ?? undefined,
          category: cleanStr(q.category) || null,  // ✅ NEW
          reward: q.reward ?? null,                // ✅ NEW
          tags: Array.isArray(q.tags) ? q.tags : undefined,
          visibility: q.visibility ?? undefined,
          restricted: Array.isArray(q.restricted) ? q.restricted : undefined,

          availableFrom: toIsoOrNull(q.availableFrom),
          availableUntil: toIsoOrNull(q.availableUntil),
          autoFailOnExpire: !!q.autoFailOnExpire,

          createdByVaultUserId: createdBy,
        });

        // Optionally set status/priority if present (createQuest defaults draft/0)
        const patch: any = {};
        if (q.status != null) patch.status = q.status;
        if (q.priority != null) patch.priority = toInt(q.priority, 0);
        if (Object.keys(patch).length) {
          questStore.updateQuest({
            worldId,
            id: created.id,
            patch,
            updatedByVaultUserId: createdBy,
          });
        }

        idMap[externalId] = created.id;
        createdQuests++;
      }

      // Objectives
      let createdObjectives = 0;
      for (const o of objectivesIn) {
        const questExternalId = cleanStr(o?.questExternalId);
        const questId = idMap[questExternalId];
        if (!questId) continue; // skip unknown mapping for now

        const title = cleanStr(o?.title);
        if (!title) continue;

        questStore.createObjective({
          worldId,
          questId,
          title,
          description: o?.description ?? undefined,
          key: o?.key ?? undefined,
          sortOrder: toInt(o?.sortOrder, 0),
          required: o?.required !== false,
        });

        createdObjectives++;
      }

      // Legacy links
      let createdLinks = 0;
      for (const l of linksIn) {
        const parentQuestId = idMap[cleanStr(l?.parentExternalId)];
        const childQuestId = idMap[cleanStr(l?.childExternalId)];
        if (!parentQuestId || !childQuestId) continue;

        const out = questStore.linkQuest({
          worldId,
          parentQuestId,
          childQuestId,
          sortOrder: toInt(l?.sortOrder, 0),
        });

        if (out.ok) createdLinks++;
      }

      // Chains (optional)
      let createdChains = 0;
      let createdChainNodes = 0;
      let createdChainEdges = 0;

      // These exist in your questStore, so we can wire them now.
      for (const c of chainsIn) {
        const title = cleanStr(c?.title);
        if (!title) continue;

        const chain = questStore.createChain({
          worldId,
          title,
          summary: c?.summary ?? null,
          tags: Array.isArray(c?.tags) ? c.tags : null,
          status: c?.status ?? "draft",
          createdByVaultUserId: createdBy ?? null,
        });

        createdChains++;

        const nodes = Array.isArray(c?.nodes) ? c.nodes : [];
        for (const n of nodes) {
          const questId = idMap[cleanStr(n?.questExternalId)];
          if (!questId) continue;

          questStore.upsertChainNode({
            worldId,
            chainId: chain.id,
            questId,
            posX: Number(n?.posX ?? 0),
            posY: Number(n?.posY ?? 0),
            ui: n?.ui ?? null,
            sortOrder: toInt(n?.sortOrder, 0),
          });

          createdChainNodes++;
        }

        const edges = Array.isArray(c?.edges) ? c.edges : [];
        for (const e of edges) {
          const fromQuestId = idMap[cleanStr(e?.fromQuestExternalId)];
          const toQuestId = idMap[cleanStr(e?.toQuestExternalId)];
          if (!fromQuestId || !toQuestId) continue;

          questStore.upsertChainEdge({
            worldId,
            chainId: chain.id,
            fromQuestId,
            toQuestId,
            gateMode: e?.gateMode ?? "all",
            condition: e?.condition ?? null,
            autoAssign: !!e?.autoAssign,
            delaySeconds: toInt(e?.delaySeconds, 0),
            ui: e?.ui ?? null,
            sortOrder: toInt(e?.sortOrder, 0),
          });

          createdChainEdges++;
        }
      }

      return ok(res, {
        worldId,
        imported: {
          quests: createdQuests,
          objectives: createdObjectives,
          links: createdLinks,
          chains: createdChains,
          chainNodes: createdChainNodes,
          chainEdges: createdChainEdges,
        },
        idMap,
      });
    } catch (err) {
      next(err);
    }
  });

  /* =========================================================
   * QUEST CHAIN GRAPH (nodes + edges)
   * ========================================================= */

  /**
   * POST /worlds/:worldId/quest-chains/:chainId/nodes
   * Body: { questId, posX?, posY?, ui?, sortOrder? }
   */
    router.post("/:worldId/quest-chains/:chainId/nodes", requireWorldMember, async (req, res, next) => {
    try {
        const anyReq = req as any;
        const { worldId, chainId } = req.params;
        await requireQuestWriteAccess(deps, anyReq, worldId);

        const questId = cleanStr(req.body?.questId);
        if (!questId) return bad(res, "Missing questId");

        const node = questStore.upsertChainNode({
        worldId,
        chainId,
        questId,
        posX: Number(req.body?.posX ?? 0),
        posY: Number(req.body?.posY ?? 0),
        ui: req.body?.ui ?? null,
        sortOrder: toInt(req.body?.sortOrder, 0),
        });

        return ok(res, { worldId, chainId, node });
    } catch (err) {
        next(err);
    }
    });

  /**
   * PATCH /worlds/:worldId/quest-chains/:chainId/nodes/:questId
   * Body: { patch: { posX?, posY?, ui?, sortOrder? } } OR direct fields
   */
  router.patch("/:worldId/quest-chains/:chainId/nodes/:questId", requireWorldMember, async (req, res, next) => {
    try {
      const anyReq = req as any;
      const { worldId, chainId, questId } = req.params;
      await requireQuestWriteAccess(deps, anyReq, worldId);

      if (typeof (questStore as any).upsertChainNode !== "function") {
        return bad(res, "questStore.upsertChainNode not implemented", 501);
      }

      const patch = (req.body?.patch ?? req.body ?? {}) as any;

      const posX = patch.posX ?? patch.pos_x;
      const posY = patch.posY ?? patch.pos_y;
      const ui = patch.ui ?? patch.ui_json;
      const sortOrder = patch.sortOrder ?? patch.sort_order;

      const node = (questStore as any).upsertChainNode({
        worldId,
        chainId,
        questId,
        posX: posX != null ? Number(posX) || 0 : undefined,
        posY: posY != null ? Number(posY) || 0 : undefined,
        ui: ui !== undefined ? ui : undefined,
        sortOrder: sortOrder != null ? toInt(sortOrder, 0) : undefined,
      });

      return ok(res, { worldId, chainId, questId, node });
    } catch (err) {
      next(err);
    }
  });

  /**
   * DELETE /worlds/:worldId/quest-chains/:chainId/nodes/:questId
   */
    router.delete("/:worldId/quest-chains/:chainId/nodes/:nodeId", requireWorldMember, async (req, res, next) => {
    try {
        const anyReq = req as any;
        const { worldId, chainId, nodeId } = req.params;
        await requireQuestWriteAccess(deps, anyReq, worldId);

        const out = questStore.deleteChainNode({ worldId, chainId, nodeId });
        return ok(res, { worldId, chainId, nodeId, ...out });
    } catch (err) {
        next(err);
    }
    });

  /**
   * POST /worlds/:worldId/quest-chains/:chainId/edges
   * Body: { fromQuestId, toQuestId, gateMode?, condition?, autoAssign?, delaySeconds?, ui?, sortOrder? }
   */
  router.post("/:worldId/quest-chains/:chainId/edges", requireWorldMember, async (req, res, next) => {
    try {
      const anyReq = req as any;
      const { worldId, chainId } = req.params;
      await requireQuestWriteAccess(deps, anyReq, worldId);

      if (typeof (questStore as any).upsertChainEdge !== "function") {
        return bad(res, "questStore.upsertChainEdge not implemented", 501);
      }

      const fromQuestId = cleanStr(req.body?.fromQuestId ?? req.body?.from_quest_id);
      const toQuestId = cleanStr(req.body?.toQuestId ?? req.body?.to_quest_id);
      if (!fromQuestId || !toQuestId) return bad(res, "Missing fromQuestId/toQuestId");

      const edge = (questStore as any).upsertChainEdge({
        worldId,
        chainId,
        fromQuestId,
        toQuestId,
        gateMode: cleanStr(req.body?.gateMode ?? req.body?.gate_mode) || "all",
        condition: req.body?.condition ?? req.body?.condition_json ?? null,
        autoAssign: toBool01(req.body?.autoAssign ?? req.body?.auto_assign, 0) === 1,
        delaySeconds: toInt(req.body?.delaySeconds ?? req.body?.delay_seconds, 0),
        ui: req.body?.ui ?? req.body?.ui_json ?? null,
        sortOrder: toInt(req.body?.sortOrder ?? req.body?.sort_order, 0),
      });

      return ok(res, { worldId, chainId, edgeId: edge.id, edge });
    } catch (err) {
      next(err);
    }
  });

  /**
   * PATCH /worlds/:worldId/quest-chains/:chainId/edges/:edgeId
   * Body: { patch: { gateMode?, condition?, autoAssign?, delaySeconds?, ui?, sortOrder? } } OR direct fields
   */
  router.patch("/:worldId/quest-chains/:chainId/edges/:edgeId", requireWorldMember, async (req, res, next) => {
    try {
      const anyReq = req as any;
      const { worldId, chainId, edgeId } = req.params;
      await requireQuestWriteAccess(deps, anyReq, worldId);

      if (typeof (questStore as any).updateChainEdge !== "function") {
        return bad(res, "questStore.updateChainEdge not implemented", 501);
      }

      const patch = (req.body?.patch ?? req.body ?? {}) as any;

      // normalize snake_case -> camelCase inputs
      if ("gate_mode" in patch && !("gateMode" in patch)) patch.gateMode = patch.gate_mode;
      if ("condition_json" in patch && !("condition" in patch)) patch.condition = patch.condition_json;
      if ("auto_assign" in patch && !("autoAssign" in patch)) patch.autoAssign = patch.auto_assign;
      if ("delay_seconds" in patch && !("delaySeconds" in patch)) patch.delaySeconds = patch.delay_seconds;
      if ("ui_json" in patch && !("ui" in patch)) patch.ui = patch.ui_json;
      if ("sort_order" in patch && !("sortOrder" in patch)) patch.sortOrder = patch.sort_order;

      const cleanPatch: any = {};
      if ("gateMode" in patch) cleanPatch.gateMode = cleanStr(patch.gateMode) || "all";
      if ("condition" in patch) cleanPatch.condition = patch.condition ?? null;
      if ("autoAssign" in patch) cleanPatch.autoAssign = toBool01(patch.autoAssign, 0) === 1;
      if ("delaySeconds" in patch) cleanPatch.delaySeconds = toInt(patch.delaySeconds, 0);
      if ("ui" in patch) cleanPatch.ui = patch.ui ?? null;
      if ("sortOrder" in patch) cleanPatch.sortOrder = toInt(patch.sortOrder, 0);

      const out = (questStore as any).updateChainEdge({
        worldId,
        chainId,
        edgeId,
        patch: cleanPatch,
        updatedByVaultUserId: getSessionUserId(anyReq) ?? undefined,
      });

      if (!out?.ok) return bad(res, out?.error ?? "Update failed", 400);
      return ok(res, { worldId, chainId, edgeId });
    } catch (err) {
      next(err);
    }
  });

  /**
   * DELETE /worlds/:worldId/quest-chains/:chainId/edges/:edgeId
   */
  router.delete("/:worldId/quest-chains/:chainId/edges/:edgeId", requireWorldMember, async (req, res, next) => {
    try {
      const anyReq = req as any;
      const { worldId, chainId, edgeId } = req.params;
      await requireQuestWriteAccess(deps, anyReq, worldId);

      if (typeof (questStore as any).deleteChainEdge !== "function") {
        return bad(res, "questStore.deleteChainEdge not implemented", 501);
      }

      const out = (questStore as any).deleteChainEdge({ worldId, chainId, edgeId });
      return ok(res, { worldId, chainId, edgeId, ...out });
    } catch (err) {
      next(err);
    }
  });
  
  return router;
}