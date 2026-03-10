// /src/services/questStore.ts
import { db } from "../services/db.js";
import { v4 as uuid } from "uuid";
function nowIso() {
    return new Date().toISOString();
}
function toInt(n, fallback = 0) {
    const x = Number(n);
    return Number.isFinite(x) ? Math.trunc(x) : fallback;
}
function safeJsonStringify(v) {
    if (v === undefined)
        return null;
    try {
        return JSON.stringify(v);
    }
    catch {
        return JSON.stringify({ _error: "unserializable" });
    }
}
function safeJsonParse(v) {
    if (!v)
        return null;
    try {
        return JSON.parse(v);
    }
    catch {
        return v;
    }
}
/** -----------------------------
 * Row mappers
 * ----------------------------- */
function rowToQuest(r) {
    return {
        id: r.id,
        worldId: r.world_id,
        templateId: r.template_id,
        title: r.title,
        summary: r.summary,
        body: r.body,
        category: r.category ?? null,
        status: r.status,
        priority: r.priority,
        tags: safeJsonParse(r.tags_json),
        reward: safeJsonParse(r.reward_json) ?? null,
        visibility: r.visibility,
        restricted: safeJsonParse(r.restricted_json),
        availableFrom: r.available_from ?? null,
        availableUntil: r.available_until ?? null,
        autoFailOnExpire: !!r.auto_fail_on_expire,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        deletedAt: r.deleted_at,
    };
}
function rowToObjective(r) {
    return {
        id: r.id,
        worldId: r.world_id,
        questId: r.quest_id,
        key: r.key,
        title: r.title,
        description: r.description,
        sortOrder: r.sort_order,
        required: !!r.required,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        deletedAt: r.deleted_at,
    };
}
function rowToObjectiveState(r) {
    return {
        id: r.id,
        worldId: r.world_id,
        objectiveId: r.objective_id,
        assignmentId: r.assignment_id,
        status: r.status,
        progressCurrent: r.progress_current ?? 0,
        progressMax: r.progress_max ?? null,
        note: r.note ?? null,
        updatedAt: r.updated_at,
    };
}
function rowToAssignment(r) {
    return {
        id: r.id,
        worldId: r.world_id,
        questId: r.quest_id,
        scope: r.scope,
        actorId: r.actor_id,
        assignedAt: r.assigned_at,
        assignedByVaultUserId: r.assigned_by_vault_user_id,
        startedAt: r.started_at ?? null,
        durationSeconds: r.duration_seconds ?? null,
        expectedCompleteAt: r.expected_complete_at ?? null,
        timeStatus: r.time_status ?? "idle",
        deletedAt: r.deleted_at,
    };
}
/** -----------------------------
 * Store
 * ----------------------------- */
export class QuestStore {
    /* =========================================================
     * Quests
     * ========================================================= */
    createQuest(args) {
        const id = `quest:${uuid()}`;
        const now = nowIso();
        db.prepare(`
    INSERT INTO quests (
        id, world_id, template_id,
        title, summary, body,
        category,
        status, priority,
        tags_json, reward_json, visibility, restricted_json,
        available_from, available_until, auto_fail_on_expire,
        created_at, updated_at,
        created_by_vault_user_id
    )
    VALUES (
        @id, @worldId, @templateId,
        @title, @summary, @body,
        @category,
        'draft', 0,
        @tags, @reward, @visibility, @restricted,
        @availableFrom, @availableUntil, @autoFailOnExpire,
        @now, @now,
        @createdBy
    )
    `).run({
            id,
            worldId: args.worldId,
            templateId: args.templateId ?? null,
            title: args.title,
            summary: args.summary ?? null,
            body: args.body ?? null,
            category: args.category ?? null, // ✅ NEW
            tags: safeJsonStringify(args.tags),
            reward: safeJsonStringify(args.reward ?? null), // ✅ FIXED
            visibility: args.visibility ?? "players",
            restricted: safeJsonStringify(args.restricted ?? null),
            availableFrom: args.availableFrom ?? null,
            availableUntil: args.availableUntil ?? null,
            autoFailOnExpire: args.autoFailOnExpire ? 1 : 0,
            now,
            createdBy: args.createdByVaultUserId ?? null,
        });
        return { ok: true, id };
    }
    getQuest(worldId, id) {
        const row = db.prepare(`
      SELECT *
      FROM quests
      WHERE id=? AND world_id=? AND deleted_at IS NULL
    `).get(id, worldId);
        return row ? rowToQuest(row) : null;
    }
    listQuests(args) {
        const worldId = String(args.worldId ?? "").trim();
        if (!worldId)
            return [];
        const where = ["world_id=@worldId", "deleted_at IS NULL"];
        const params = { worldId };
        if (args.status) {
            where.push("status=@status");
            params.status = args.status;
        }
        if (args.visibility) {
            where.push("visibility=@visibility");
            params.visibility = args.visibility;
        }
        const rows = db.prepare(`
      SELECT *
      FROM quests
      WHERE ${where.join(" AND ")}
      ORDER BY priority DESC, created_at DESC
    `).all(params);
        return rows.map(rowToQuest);
    }
    updateQuest(args) {
        const now = nowIso();
        const sets = [];
        const params = {
            worldId: args.worldId,
            id: args.id,
            now,
            updatedBy: args.updatedByVaultUserId ?? null,
        };
        for (const [k, v] of Object.entries(args.patch ?? {})) {
            if (k === "tags") {
                sets.push(`tags_json=@tags`);
                params.tags = safeJsonStringify(v);
            }
            else if (k === "reward") { // ✅ NEW
                sets.push(`reward_json=@reward`);
                params.reward = safeJsonStringify(v);
            }
            else if (k === "restricted") {
                sets.push(`restricted_json=@restricted`);
                params.restricted = safeJsonStringify(v);
            }
            else if (k === "availableFrom") {
                sets.push(`available_from=@availableFrom`);
                params.availableFrom = v ?? null;
            }
            else if (k === "availableUntil") {
                sets.push(`available_until=@availableUntil`);
                params.availableUntil = v ?? null;
            }
            else if (k === "category") { // ✅ NEW (optional; the "else" would also work)
                sets.push(`category=@category`);
                params.category = v ?? null;
            }
            else if (k === "autoFailOnExpire") {
                sets.push(`auto_fail_on_expire=@autoFailOnExpire`);
                params.autoFailOnExpire = v ? 1 : 0;
            }
            else {
                sets.push(`${k}=@${k}`);
                params[k] = v;
            }
        }
        if (!sets.length)
            return { ok: false, error: "No fields to update" };
        db.prepare(`
      UPDATE quests
      SET ${sets.join(", ")},
          updated_at=@now,
          updated_by_vault_user_id=@updatedBy
      WHERE id=@id AND world_id=@worldId AND deleted_at IS NULL
    `).run(params);
        return { ok: true };
    }
    deleteQuest(worldId, id) {
        db.prepare(`
      UPDATE quests
      SET deleted_at=@now, updated_at=@now
      WHERE id=@id AND world_id=@worldId
    `).run({ now: nowIso(), id, worldId });
        return { ok: true };
    }
    isQuestCurrentlyAvailable(args) {
        const row = db.prepare(`
      SELECT available_from, available_until
      FROM quests
      WHERE id=? AND world_id=? AND deleted_at IS NULL
    `).get(args.questId, args.worldId);
        if (!row)
            return false;
        const now = new Date();
        if (row.available_from && new Date(row.available_from) > now)
            return false;
        if (row.available_until && new Date(row.available_until) < now)
            return false;
        return true;
    }
    /** If you want to auto-fail expired quests (when auto_fail_on_expire=1). */
    expireOverdueQuests(worldId) {
        const now = nowIso();
        const info = db.prepare(`
      UPDATE quests
      SET status='failed', updated_at=@now
      WHERE world_id=@worldId
        AND deleted_at IS NULL
        AND status='active'
        AND auto_fail_on_expire=1
        AND available_until IS NOT NULL
        AND available_until < @now
    `).run({ worldId, now });
        return { ok: true, failed: info.changes ?? 0 };
    }
    /* =========================================================
     * Assignments (timers live here)
     * ========================================================= */
    pauseTimedAssignment(args) {
        return this.setAssignmentTimeStatus({ ...args, timeStatus: "paused" });
    }
    resumeTimedAssignment(args) {
        const row = db.prepare(`
        SELECT started_at, duration_seconds, expected_complete_at, time_status
        FROM quest_assignments
        WHERE id=? AND world_id=? AND deleted_at IS NULL
    `).get(args.assignmentId, args.worldId);
        if (!row)
            return { ok: false, error: "Assignment not found" };
        if (row.time_status !== "paused")
            return { ok: false, error: "Not paused" };
        if (!row.expected_complete_at)
            return { ok: false, error: "Missing expected_complete_at" };
        const now = new Date();
        const expected = new Date(row.expected_complete_at);
        const remainingSec = Math.max(0, Math.ceil((expected.getTime() - now.getTime()) / 1000));
        db.prepare(`
        UPDATE quest_assignments
        SET started_at=@startedAt,
            duration_seconds=@durationSeconds,
            time_status='running'
        WHERE id=@assignmentId AND world_id=@worldId AND deleted_at IS NULL
    `).run({
            worldId: args.worldId,
            assignmentId: args.assignmentId,
            startedAt: now.toISOString(),
            durationSeconds: remainingSec,
        });
        // trigger will recompute expected_complete_at for you
        return { ok: true, remainingSec };
    }
    createAssignment(args) {
        const id = `qa:${uuid()}`;
        const assignedAt = nowIso();
        const startedAt = args.startedAt ?? null;
        const durationSeconds = args.durationSeconds ?? null;
        const expectedCompleteAt = startedAt && durationSeconds != null
            ? new Date(new Date(startedAt).getTime() + toInt(durationSeconds) * 1000).toISOString()
            : null;
        db.prepare(`
        INSERT INTO quest_assignments (
        id, world_id, quest_id,
        scope, actor_id,
        assigned_at, assigned_by_vault_user_id,
        started_at, duration_seconds, expected_complete_at, time_status,
        deleted_at
        )
        VALUES (
        @id, @worldId, @questId,
        @scope, @actorId,
        @assignedAt, @assignedBy,
        @startedAt, @durationSeconds, @expectedCompleteAt, @timeStatus,
        NULL
        )
    `).run({
            id,
            worldId: args.worldId,
            questId: args.questId,
            scope: args.scope,
            actorId: args.scope === "actor" ? (args.actorId ?? null) : null,
            assignedAt,
            assignedBy: args.assignedByVaultUserId ?? null,
            startedAt,
            durationSeconds: durationSeconds != null ? toInt(durationSeconds) : null,
            expectedCompleteAt,
            timeStatus: args.timeStatus ?? (startedAt ? "running" : "idle"),
        });
        return { ok: true, id };
    }
    getAssignment(args) {
        const row = db.prepare(`
      SELECT *
      FROM quest_assignments
      WHERE id=? AND world_id=? AND deleted_at IS NULL
    `).get(args.assignmentId, args.worldId);
        return row ? rowToAssignment(row) : null;
    }
    listAssignments(args) {
        const worldId = String(args.worldId ?? "").trim();
        if (!worldId)
            return [];
        const where = ["world_id=@worldId", "deleted_at IS NULL"];
        const params = { worldId };
        if (args.questId) {
            where.push("quest_id=@questId");
            params.questId = args.questId;
        }
        if (args.actorId != null) {
            where.push("actor_id=@actorId");
            params.actorId = args.actorId;
        }
        const rows = db.prepare(`
      SELECT *
      FROM quest_assignments
      WHERE ${where.join(" AND ")}
      ORDER BY assigned_at DESC
    `).all(params);
        return rows.map(rowToAssignment);
    }
    startTimedAssignment(args) {
        const now = new Date();
        const expected = new Date(now.getTime() + toInt(args.durationSeconds) * 1000);
        db.prepare(`
      UPDATE quest_assignments
      SET
        started_at=@startedAt,
        duration_seconds=@duration,
        expected_complete_at=@expected,
        time_status='running'
      WHERE id=@assignmentId AND world_id=@worldId AND deleted_at IS NULL
    `).run({
            worldId: args.worldId,
            assignmentId: args.assignmentId,
            startedAt: now.toISOString(),
            duration: toInt(args.durationSeconds),
            expected: expected.toISOString(),
        });
        return { ok: true };
    }
    setAssignmentTimeStatus(args) {
        db.prepare(`
      UPDATE quest_assignments
      SET time_status=@timeStatus
      WHERE id=@assignmentId AND world_id=@worldId AND deleted_at IS NULL
    `).run(args);
        return { ok: true };
    }
    completeTimedAssignment(args) {
        return this.setAssignmentTimeStatus({ ...args, timeStatus: "complete" });
    }
    expireOverdueAssignments(worldId) {
        const now = nowIso();
        const info = db.prepare(`
      UPDATE quest_assignments
      SET time_status='expired'
      WHERE world_id=@worldId
        AND deleted_at IS NULL
        AND time_status='running'
        AND expected_complete_at IS NOT NULL
        AND expected_complete_at < @now
    `).run({ worldId, now });
        return { ok: true, expired: info.changes ?? 0 };
    }
    /* =========================================================
     * Legacy Quest links (parent/child)
     * ========================================================= */
    linkQuest(args) {
        const id = `ql:${uuid()}`;
        if (args.parentQuestId === args.childQuestId) {
            return { ok: false, error: "parentQuestId cannot equal childQuestId" };
        }
        db.prepare(`
      INSERT INTO quest_links (
        id, world_id,
        parent_quest_id, child_quest_id,
        sort_order,
        created_at
      )
      VALUES (
        @id, @worldId,
        @parentId, @childId,
        @sortOrder,
        @now
      )
      ON CONFLICT(world_id, parent_quest_id, child_quest_id)
      DO UPDATE SET sort_order=excluded.sort_order
    `).run({
            id,
            worldId: args.worldId,
            parentId: args.parentQuestId,
            childId: args.childQuestId,
            sortOrder: toInt(args.sortOrder, 0),
            now: nowIso(),
        });
        return { ok: true, id };
    }
    unlinkQuest(args) {
        const info = db.prepare(`
      DELETE FROM quest_links
      WHERE world_id=? AND parent_quest_id=? AND child_quest_id=?
    `).run(args.worldId, args.parentQuestId, args.childQuestId);
        return { ok: true, deleted: info.changes ?? 0 };
    }
    listChildren(args) {
        const rows = db.prepare(`
      SELECT *
      FROM quest_links
      WHERE world_id=? AND parent_quest_id=?
      ORDER BY sort_order ASC, created_at ASC
    `).all(args.worldId, args.parentQuestId);
        return rows.map((r) => ({
            id: r.id,
            worldId: r.world_id,
            parentQuestId: r.parent_quest_id,
            childQuestId: r.child_quest_id,
            sortOrder: r.sort_order,
            createdAt: r.created_at,
        }));
    }
    listParents(args) {
        const rows = db.prepare(`
      SELECT *
      FROM quest_links
      WHERE world_id=? AND child_quest_id=?
      ORDER BY sort_order ASC, created_at ASC
    `).all(args.worldId, args.childQuestId);
        return rows.map((r) => ({
            id: r.id,
            worldId: r.world_id,
            parentQuestId: r.parent_quest_id,
            childQuestId: r.child_quest_id,
            sortOrder: r.sort_order,
            createdAt: r.created_at,
        }));
    }
    getChain(args) {
        const root = this.getQuest(args.worldId, args.rootQuestId);
        if (!root)
            return { root: null, children: [] };
        const edges = this.listChildren({ worldId: args.worldId, parentQuestId: args.rootQuestId });
        const children = edges
            .map((e) => this.getQuest(args.worldId, e.childQuestId))
            .filter(Boolean);
        return { root, children };
    }
    /* =========================================================
     * Objectives (definition)
     * ========================================================= */
    createObjective(args) {
        const id = `qo:${uuid()}`;
        const now = nowIso();
        db.prepare(`
      INSERT INTO quest_objectives (
        id, world_id, quest_id,
        key, title, description,
        sort_order, required,
        created_at, updated_at
      )
      VALUES (
        @id, @worldId, @questId,
        @key, @title, @description,
        @sortOrder, @required,
        @now, @now
      )
    `).run({
            id,
            worldId: args.worldId,
            questId: args.questId,
            key: args.key ?? null,
            title: args.title,
            description: args.description ?? null,
            sortOrder: toInt(args.sortOrder, 0),
            required: args.required === false ? 0 : 1,
            now,
        });
        return { ok: true, id };
    }
    updateObjective(args) {
        const now = nowIso();
        const sets = [];
        const params = { worldId: args.worldId, id: args.id, now };
        for (const [k, v] of Object.entries(args.patch ?? {})) {
            if (k === "required") {
                sets.push(`required=@required`);
                params.required = v ? 1 : 0;
            }
            else if (k === "sortOrder") {
                sets.push(`sort_order=@sortOrder`);
                params.sortOrder = toInt(v, 0);
            }
            else if (k === "description") {
                sets.push(`description=@description`);
                params.description = v ?? null;
            }
            else if (k === "key") {
                sets.push(`key=@key`);
                params.key = v ?? null;
            }
            else {
                sets.push(`${k}=@${k}`);
                params[k] = v;
            }
        }
        if (!sets.length)
            return { ok: false, error: "No fields to update" };
        db.prepare(`
      UPDATE quest_objectives
      SET ${sets.join(", ")},
          updated_at=@now
      WHERE id=@id AND world_id=@worldId AND deleted_at IS NULL
    `).run(params);
        return { ok: true };
    }
    listObjectives(args) {
        const rows = db.prepare(`
      SELECT *
      FROM quest_objectives
      WHERE world_id=? AND quest_id=? AND deleted_at IS NULL
      ORDER BY sort_order ASC, created_at ASC
    `).all(args.worldId, args.questId);
        return rows.map(rowToObjective);
    }
    deleteObjective(args) {
        const now = nowIso();
        db.prepare(`
      UPDATE quest_objectives
      SET deleted_at=@now, updated_at=@now
      WHERE id=@id AND world_id=@worldId
    `).run({ worldId: args.worldId, id: args.id, now });
        return { ok: true };
    }
    /* =========================================================
     * Objective state (per assignment)
     * ========================================================= */
    ensureObjectiveState(args) {
        const id = `qos:${uuid()}`;
        const now = nowIso();
        db.prepare(`
      INSERT INTO quest_objective_states (
        id, world_id,
        objective_id, assignment_id,
        status, progress_current, progress_max,
        note, updated_at
      )
      VALUES (
        @id, @worldId,
        @objectiveId, @assignmentId,
        @status, @cur, @max,
        @note, @now
      )
      ON CONFLICT(objective_id, assignment_id) DO NOTHING
    `).run({
            id,
            worldId: args.worldId,
            objectiveId: args.objectiveId,
            assignmentId: args.assignmentId,
            status: args.status ?? "open",
            cur: toInt(args.progressCurrent, 0),
            max: args.progressMax ?? null,
            note: args.note ?? null,
            now,
        });
        return { ok: true };
    }
    updateObjectiveState(args) {
        const now = nowIso();
        const sets = [];
        const params = {
            worldId: args.worldId,
            objectiveId: args.objectiveId,
            assignmentId: args.assignmentId,
            now,
        };
        for (const [k, v] of Object.entries(args.patch ?? {})) {
            if (k === "progressCurrent") {
                sets.push(`progress_current=@progressCurrent`);
                params.progressCurrent = toInt(v, 0);
            }
            else if (k === "progressMax") {
                sets.push(`progress_max=@progressMax`);
                params.progressMax = v == null ? null : toInt(v);
            }
            else if (k === "note") {
                sets.push(`note=@note`);
                params.note = v == null ? null : String(v);
            }
            else {
                sets.push(`${k}=@${k}`);
                params[k] = v;
            }
        }
        if (!sets.length)
            return { ok: false, error: "No fields to update" };
        // lazy create if missing
        this.ensureObjectiveState({
            worldId: args.worldId,
            objectiveId: args.objectiveId,
            assignmentId: args.assignmentId,
        });
        db.prepare(`
      UPDATE quest_objective_states
      SET ${sets.join(", ")},
          updated_at=@now
      WHERE world_id=@worldId
        AND objective_id=@objectiveId
        AND assignment_id=@assignmentId
    `).run(params);
        return { ok: true };
    }
    listObjectiveStates(args) {
        const rows = db.prepare(`
      SELECT *
      FROM quest_objective_states
      WHERE world_id=? AND assignment_id=?
      ORDER BY updated_at DESC
    `).all(args.worldId, args.assignmentId);
        return rows.map(rowToObjectiveState);
    }
    getObjectivesWithState(args) {
        const objectives = this.listObjectives({ worldId: args.worldId, questId: args.questId });
        const states = this.listObjectiveStates({ worldId: args.worldId, assignmentId: args.assignmentId });
        const byObj = new Map(states.map((s) => [s.objectiveId, s]));
        return objectives.map((o) => ({ objective: o, state: byObj.get(o.id) ?? null }));
    }
    recomputeQuestStatusFromObjectives(args) {
        const rows = this.getObjectivesWithState(args);
        const required = rows.filter((r) => r.objective.required);
        if (!required.length)
            return { ok: true, shouldComplete: false };
        const allComplete = required.every((r) => (r.state?.status ?? "open") === "complete");
        return { ok: true, shouldComplete: allComplete };
    }
    /* =========================================================
     * Vue Flow: Chains / Nodes / Edges
     * ========================================================= */
    createChain(args) {
        const id = `qc:${uuid()}`;
        const now = nowIso();
        db.prepare(`
      INSERT INTO quest_chains (
        id, world_id,
        title, summary, tags_json,
        status,
        created_at, updated_at,
        created_by_vault_user_id, updated_by_vault_user_id,
        deleted_at
      )
      VALUES (
        @id, @worldId,
        @title, @summary, @tags,
        @status,
        @now, @now,
        @createdBy, @createdBy,
        NULL
      )
    `).run({
            id,
            worldId: args.worldId,
            title: args.title,
            summary: args.summary ?? null,
            tags: safeJsonStringify(args.tags ?? null),
            status: String(args.status ?? "draft"),
            now,
            createdBy: args.createdByVaultUserId ?? null,
        });
        return { ok: true, id };
    }
    updateChain(args) {
        const now = nowIso();
        const sets = [];
        const params = {
            worldId: args.worldId,
            chainId: args.chainId,
            now,
            updatedBy: args.updatedByVaultUserId ?? null,
        };
        for (const [k, v] of Object.entries(args.patch ?? {})) {
            if (k === "tags") {
                sets.push(`tags_json=@tags`);
                params.tags = safeJsonStringify(v);
            }
            else {
                sets.push(`${k}=@${k}`);
                params[k] = v;
            }
        }
        if (!sets.length)
            return { ok: false, error: "No fields to update" };
        db.prepare(`
      UPDATE quest_chains
      SET ${sets.join(", ")},
          updated_at=@now,
          updated_by_vault_user_id=@updatedBy
      WHERE id=@chainId AND world_id=@worldId AND deleted_at IS NULL
    `).run(params);
        return { ok: true };
    }
    deleteChain(args) {
        const now = nowIso();
        db.prepare(`
      UPDATE quest_chains
      SET deleted_at=@now, updated_at=@now
      WHERE id=@chainId AND world_id=@worldId
    `).run({ ...args, now });
        return { ok: true };
    }
    listChains(worldId) {
        const rows = db.prepare(`
      SELECT *
      FROM quest_chains
      WHERE world_id=? AND deleted_at IS NULL
      ORDER BY updated_at DESC
    `).all(worldId);
        return rows.map((r) => ({
            id: r.id,
            worldId: r.world_id,
            title: r.title,
            summary: r.summary,
            tags: safeJsonParse(r.tags_json),
            status: r.status,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
            deletedAt: r.deleted_at,
        }));
    }
    upsertChainNode(args) {
        const now = nowIso();
        const id = `qcn:${uuid()}`;
        // If the same quest is added twice, you *may* want uniqueness; schema doesn’t enforce it.
        db.prepare(`
      INSERT INTO quest_chain_nodes (
        id, world_id, chain_id,
        quest_id,
        pos_x, pos_y,
        ui_json,
        sort_order,
        created_at, updated_at,
        deleted_at
      )
      VALUES (
        @id, @worldId, @chainId,
        @questId,
        @posX, @posY,
        @ui,
        @sortOrder,
        @now, @now,
        NULL
      )
    `).run({
            id,
            worldId: args.worldId,
            chainId: args.chainId,
            questId: args.questId,
            posX: Number(args.posX ?? 0),
            posY: Number(args.posY ?? 0),
            ui: safeJsonStringify(args.ui ?? null),
            sortOrder: toInt(args.sortOrder, 0),
            now,
        });
        return { ok: true, id };
    }
    updateChainNode(args) {
        const now = nowIso();
        const sets = [];
        const params = { worldId: args.worldId, nodeId: args.nodeId, now };
        for (const [k, v] of Object.entries(args.patch ?? {})) {
            if (k === "posX") {
                sets.push(`pos_x=@posX`);
                params.posX = Number(v ?? 0);
            }
            else if (k === "posY") {
                sets.push(`pos_y=@posY`);
                params.posY = Number(v ?? 0);
            }
            else if (k === "ui") {
                sets.push(`ui_json=@ui`);
                params.ui = safeJsonStringify(v);
            }
            else if (k === "sortOrder") {
                sets.push(`sort_order=@sortOrder`);
                params.sortOrder = toInt(v, 0);
            }
            else if (k === "questId") {
                sets.push(`quest_id=@questId`);
                params.questId = String(v);
            }
        }
        if (!sets.length)
            return { ok: false, error: "No fields to update" };
        db.prepare(`
      UPDATE quest_chain_nodes
      SET ${sets.join(", ")},
          updated_at=@now
      WHERE id=@nodeId AND world_id=@worldId AND deleted_at IS NULL
    `).run(params);
        return { ok: true };
    }
    deleteChainNode(args) {
        const now = nowIso();
        db.prepare(`
      UPDATE quest_chain_nodes
      SET deleted_at=@now, updated_at=@now
      WHERE id=@nodeId AND world_id=@worldId
    `).run({ ...args, now });
        return { ok: true };
    }
    upsertChainEdge(args) {
        const now = nowIso();
        const id = `qce:${uuid()}`;
        db.prepare(`
      INSERT INTO quest_chain_edges (
        id, world_id, chain_id,
        from_quest_id, to_quest_id,
        gate_mode, condition_json, auto_assign,
        delay_seconds,
        ui_json,
        sort_order,
        created_at, updated_at,
        deleted_at
      )
      VALUES (
        @id, @worldId, @chainId,
        @fromQuestId, @toQuestId,
        @gateMode, @condition, @autoAssign,
        @delaySeconds,
        @ui,
        @sortOrder,
        @now, @now,
        NULL
      )
    `).run({
            id,
            worldId: args.worldId,
            chainId: args.chainId,
            fromQuestId: args.fromQuestId,
            toQuestId: args.toQuestId,
            gateMode: String(args.gateMode ?? "all"),
            condition: safeJsonStringify(args.condition ?? null),
            autoAssign: args.autoAssign ? 1 : 0,
            delaySeconds: toInt(args.delaySeconds, 0),
            ui: safeJsonStringify(args.ui ?? null),
            sortOrder: toInt(args.sortOrder, 0),
            now,
        });
        return { ok: true, id };
    }
    updateChainEdge(args) {
        const now = nowIso();
        const sets = [];
        const params = { worldId: args.worldId, edgeId: args.edgeId, now };
        for (const [k, v] of Object.entries(args.patch ?? {})) {
            if (k === "fromQuestId") {
                sets.push(`from_quest_id=@fromQuestId`);
                params.fromQuestId = String(v);
            }
            else if (k === "toQuestId") {
                sets.push(`to_quest_id=@toQuestId`);
                params.toQuestId = String(v);
            }
            else if (k === "gateMode") {
                sets.push(`gate_mode=@gateMode`);
                params.gateMode = String(v);
            }
            else if (k === "condition") {
                sets.push(`condition_json=@condition`);
                params.condition = safeJsonStringify(v);
            }
            else if (k === "autoAssign") {
                sets.push(`auto_assign=@autoAssign`);
                params.autoAssign = v ? 1 : 0;
            }
            else if (k === "delaySeconds") {
                sets.push(`delay_seconds=@delaySeconds`);
                params.delaySeconds = toInt(v, 0);
            }
            else if (k === "ui") {
                sets.push(`ui_json=@ui`);
                params.ui = safeJsonStringify(v);
            }
            else if (k === "sortOrder") {
                sets.push(`sort_order=@sortOrder`);
                params.sortOrder = toInt(v, 0);
            }
        }
        if (!sets.length)
            return { ok: false, error: "No fields to update" };
        db.prepare(`
      UPDATE quest_chain_edges
      SET ${sets.join(", ")},
          updated_at=@now
      WHERE id=@edgeId AND world_id=@worldId AND deleted_at IS NULL
    `).run(params);
        return { ok: true };
    }
    deleteChainEdge(args) {
        const now = nowIso();
        db.prepare(`
      UPDATE quest_chain_edges
      SET deleted_at=@now, updated_at=@now
      WHERE id=@edgeId AND world_id=@worldId
    `).run({ ...args, now });
        return { ok: true };
    }
    /** For vue-flow: returns nodes/edges arrays in a format you can map into VueFlowNode/VueFlowEdge easily */
    getChainGraph(args) {
        const nodes = db.prepare(`
      SELECT *
      FROM quest_chain_nodes
      WHERE world_id=? AND chain_id=? AND deleted_at IS NULL
      ORDER BY sort_order ASC, updated_at ASC
    `).all(args.worldId, args.chainId);
        const edges = db.prepare(`
      SELECT *
      FROM quest_chain_edges
      WHERE world_id=? AND chain_id=? AND deleted_at IS NULL
      ORDER BY sort_order ASC, updated_at ASC
    `).all(args.worldId, args.chainId);
        return {
            nodes: nodes.map((n) => ({
                id: n.id,
                worldId: n.world_id,
                chainId: n.chain_id,
                questId: n.quest_id,
                posX: n.pos_x,
                posY: n.pos_y,
                ui: safeJsonParse(n.ui_json) ?? null,
                sortOrder: n.sort_order,
                createdAt: n.created_at,
                updatedAt: n.updated_at,
            })),
            edges: edges.map((e) => ({
                id: e.id,
                worldId: e.world_id,
                chainId: e.chain_id,
                fromQuestId: e.from_quest_id,
                toQuestId: e.to_quest_id,
                gateMode: e.gate_mode,
                condition: safeJsonParse(e.condition_json) ?? null,
                autoAssign: !!e.auto_assign,
                delaySeconds: e.delay_seconds ?? 0,
                ui: safeJsonParse(e.ui_json) ?? null,
                sortOrder: e.sort_order,
                createdAt: e.created_at,
                updatedAt: e.updated_at,
            })),
        };
    }
}
export const questStore = new QuestStore();
//# sourceMappingURL=questStore.js.map