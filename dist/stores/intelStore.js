// /src/services/intelStore.ts
import { db } from "../services/db.js";
import { v4 as uuid } from "uuid";
function nowIso() {
    return new Date().toISOString();
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
function toStr(x) {
    return String(x ?? "").trim();
}
function rowToMediaObject(r) {
    return {
        id: r.id,
        worldId: r.world_id,
        kind: r.kind,
        filename: r.filename,
        mimeType: r.mime_type,
        byteSize: r.byte_size,
        sha256: r.sha256,
        storage: r.storage,
        path: r.path,
        createdAt: r.created_at,
        createdByVaultUserId: r.created_by_vault_user_id,
        deletedAt: r.deleted_at,
    };
}
function rowToIntel(r) {
    return {
        id: r.id,
        worldId: r.world_id,
        title: r.title,
        kind: r.kind,
        summary: r.summary,
        body: r.body,
        tags: safeJsonParse(r.tags_json),
        scope: r.scope || "party",
        actorId: r.actor_id,
        visibility: r.visibility || "players",
        restricted: safeJsonParse(r.restricted_json),
        discoveredAt: r.discovered_at,
        discoveredByActorId: r.discovered_by_actor_id,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        createdByVaultUserId: r.created_by_vault_user_id,
        updatedByVaultUserId: r.updated_by_vault_user_id
    };
}
function rowToAttachment(r) {
    return {
        id: r.id,
        worldId: r.world_id,
        intelId: r.intel_id,
        mediaId: r.media_id,
        caption: r.caption,
        sortOrder: Number(r.sort_order ?? 0),
        createdAt: r.created_at,
        deletedAt: r.deleted_at
    };
}
/**
 * Enforce the same integrity your schema CHECK expects:
 * - scope=party => actor_id should be null/empty
 * - scope=player => actor_id required
 */
function normalizeScopeActor(scope, actorId) {
    if (scope === "party")
        return { scope, actorId: null };
    const a = toStr(actorId);
    if (!a)
        throw new Error("actorId is required when scope='player'");
    return { scope, actorId: a };
}
export class IntelStore {
    /* =========================================================
     * CREATE
     * ========================================================= */
    createIntel(args) {
        const id = `intel:${uuid()}`;
        const now = nowIso();
        const scope = (args.scope ?? "party");
        const { actorId } = normalizeScopeActor(scope, args.actorId);
        db.prepare(`
      INSERT INTO intel (
        id, world_id,
        title, kind,
        summary, body,
        tags_json,
        scope, actor_id,
        visibility, restricted_json,
        discovered_at, discovered_by_actor_id,
        created_at, updated_at,
        created_by_vault_user_id
      )
      VALUES (
        @id, @worldId,
        @title, @kind,
        @summary, @body,
        @tags,
        @scope, @actorId,
        @visibility, @restricted,
        @discoveredAt, @discoveredByActorId,
        @now, @now,
        @createdBy
      )
    `).run({
            id,
            worldId: toStr(args.worldId),
            title: toStr(args.title),
            kind: toStr(args.kind),
            summary: args.summary ?? null,
            body: args.body ?? null,
            tags: safeJsonStringify(args.tags),
            scope,
            actorId,
            visibility: args.visibility ?? "players",
            restricted: safeJsonStringify(args.restricted),
            discoveredAt: args.discoveredAt ?? null,
            discoveredByActorId: args.discoveredByActorId ?? null,
            now,
            createdBy: args.createdByVaultUserId ?? null
        });
        return { ok: true, id };
    }
    /* =========================================================
     * UPDATE / DISCOVERY
     * ========================================================= */
    updateIntel(args) {
        const now = nowIso();
        const sets = [];
        const params = {
            worldId: toStr(args.worldId),
            id: toStr(args.id),
            now,
            updatedBy: args.updatedByVaultUserId ?? null
        };
        // If patch includes scope and/or actorId, normalize to satisfy CHECK.
        const nextScope = (args.patch.scope ?? null);
        const nextActorId = (Object.prototype.hasOwnProperty.call(args.patch, "actorId")
            ? args.patch.actorId
            : undefined);
        if (nextScope != null || nextActorId !== undefined) {
            const current = this.getIntel(args.worldId, args.id);
            if (!current)
                return { ok: false, error: "Intel not found" };
            const mergedScope = (nextScope ?? current.scope);
            const mergedActorId = nextActorId !== undefined ? nextActorId : (current.actorId ?? null);
            const normalized = normalizeScopeActor(mergedScope, mergedActorId);
            sets.push(`scope=@scope`);
            params.scope = normalized.scope;
            sets.push(`actor_id=@actorId`);
            params.actorId = normalized.actorId;
        }
        for (const [k, v] of Object.entries(args.patch ?? {})) {
            if (k === "scope" || k === "actorId")
                continue;
            if (k === "tags") {
                sets.push(`tags_json=@tags`);
                params.tags = safeJsonStringify(v);
                continue;
            }
            if (k === "restricted") {
                sets.push(`restricted_json=@restricted`);
                params.restricted = safeJsonStringify(v);
                continue;
            }
            // simple columns
            const col = k === "discoveredAt" ? "discovered_at" :
                k === "discoveredByActorId" ? "discovered_by_actor_id" :
                    k;
            sets.push(`${col}=@${k}`);
            params[k] = v;
        }
        if (!sets.length)
            return { ok: false, error: "No fields to update" };
        db.prepare(`
      UPDATE intel
      SET ${sets.join(", ")},
          updated_at=@now,
          updated_by_vault_user_id=@updatedBy
      WHERE id=@id AND world_id=@worldId AND deleted_at IS NULL
    `).run(params);
        return { ok: true };
    }
    /**
     * Mark something as "discovered" (and optionally by whom).
     * Good for when players find a clue/map in-session.
     */
    markDiscovered(args) {
        return this.updateIntel({
            worldId: args.worldId,
            id: args.id,
            patch: {
                discoveredAt: args.discoveredAt ?? nowIso(),
                discoveredByActorId: args.discoveredByActorId ?? null
            },
            updatedByVaultUserId: args.updatedByVaultUserId
        });
    }
    /* =========================================================
     * READ
     * ========================================================= */
    getIntel(worldId, id) {
        const row = db.prepare(`
      SELECT *
      FROM intel
      WHERE id=? AND world_id=? AND deleted_at IS NULL
    `).get(toStr(id), toStr(worldId));
        return row ? rowToIntel(row) : null;
    }
    listAttachmentsForIntelIds(args) {
        const worldId = toStr(args.worldId);
        const ids = (args.intelIds ?? []).map(toStr).filter(Boolean);
        if (!worldId || !ids.length)
            return new Map();
        const placeholders = ids.map(() => "?").join(",");
        const rows = db.prepare(`
        SELECT
        ia.id         AS attachment_id,
        ia.intel_id   AS intel_id,
        ia.media_id   AS media_id,
        ia.caption    AS caption,
        ia.sort_order AS sort_order,
        ia.created_at AS created_at,

        mo.filename   AS filename,
        mo.mime_type  AS mime_type,
        mo.byte_size  AS byte_size,
        mo.path       AS path,
        mo.kind       AS media_kind
        FROM intel_attachments ia
        JOIN media_objects mo
        ON mo.id = ia.media_id
        WHERE ia.world_id = ?
        AND ia.deleted_at IS NULL
        AND mo.deleted_at IS NULL
        AND ia.intel_id IN (${placeholders})
        ORDER BY ia.intel_id ASC, ia.sort_order ASC, ia.created_at ASC
    `).all(worldId, ...ids);
        const byIntelId = new Map();
        for (const r of rows) {
            const intelId = String(r.intel_id);
            const list = byIntelId.get(intelId) ?? [];
            list.push({
                // attachment identity
                id: String(r.attachment_id),
                attachmentId: String(r.attachment_id),
                worldId,
                intelId,
                // media identity
                mediaId: String(r.media_id),
                filename: r.filename ?? null,
                mime: r.mime_type ?? null,
                byteSize: r.byte_size ?? null,
                path: r.path ?? null,
                url: r.path ? `/media/${String(r.path).replace(/^\/+/, "")}` : null,
                // attachment fields
                caption: r.caption ?? null,
                sortOrder: Number(r.sort_order ?? 0),
                createdAt: r.created_at ?? null,
            });
            byIntelId.set(intelId, list);
        }
        return byIntelId;
    }
    /**
     * Visibility-aware listing.
     * - viewerRole="gm" sees all
     * - viewerRole="player" sees:
     *   - visibility='players'
     *   - visibility='restricted' only if viewerActorId is in restricted_json
     *   - plus scope rules (party vs player-specific)
     */
    listIntel(args) {
        const worldId = toStr(args.worldId);
        if (!worldId)
            return [];
        const viewerRole = args.viewerRole ?? "player";
        const viewerActorId = toStr(args.viewerActorId ?? args.actorId ?? "");
        const where = [
            `world_id=@worldId`,
            `deleted_at IS NULL`,
        ];
        const params = {
            worldId,
            limit: Math.max(1, Math.min(500, Math.trunc(Number(args.limit ?? 200)))),
        };
        if (args.kind) {
            where.push(`kind=@kind`);
            params.kind = toStr(args.kind);
        }
        if (args.scope) {
            where.push(`scope=@scope`);
            params.scope = toStr(args.scope);
        }
        // NEW: discovered-only filter (used by player journal list)
        if (args.discoveredOnly) {
            where.push(`discovered_at IS NOT NULL`);
        }
        // Scope behavior:
        // - If viewer provides actorId: allow party OR their personal intel
        // - If no actorId: only party intel
        //
        // NOTE: This still allows party intel even without actor id (good),
        // and allows personal intel only when actorId provided.
        if (viewerActorId) {
            where.push(`(scope='party' OR (scope='player' AND actor_id=@viewerActorId))`);
            params.viewerActorId = viewerActorId;
        }
        else {
            where.push(`scope='party'`);
        }
        // Visibility behavior:
        // - GM sees all (no extra where)
        // - Player: players + restricted (restricted enforced in JS)
        if (viewerRole !== "gm") {
            where.push(`visibility IN ('players','restricted')`);
        }
        if (args.beforeCreatedAt) {
            where.push(`created_at < @beforeCreatedAt`);
            params.beforeCreatedAt = toStr(args.beforeCreatedAt);
        }
        const sql = `
        SELECT *
        FROM intel
        WHERE ${where.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT @limit
    `;
        const rows = db.prepare(sql).all(params);
        let out = rows.map(rowToIntel);
        // Enforce restricted membership in JS (works even without json1)
        if (viewerRole !== "gm") {
            out = out.filter((it) => {
                if (it.visibility === "players")
                    return true;
                if (it.visibility !== "restricted")
                    return false;
                // If restricted and no viewerActorId, they can't pass the check
                if (!viewerActorId)
                    return false;
                const restricted = (it.restricted ?? []);
                return Array.isArray(restricted) && restricted.map(String).includes(viewerActorId);
            });
        }
        if (args.includeAttachments && out.length) {
            const byIntelId = this.listAttachmentsForIntelIds({
                worldId,
                intelIds: out.map((x) => x.id),
            });
            out = out.map((it) => {
                const attachments = byIntelId.get(it.id) ?? [];
                const thumbUrl = attachments[0]?.url ?? null;
                return { ...it, attachments, thumbUrl };
            });
        }
        return out;
    }
    /* =========================================================
     * MEDIA OBJECTS
     * ========================================================= */
    createMedia(args) {
        const id = `media:${uuid()}`;
        const now = nowIso();
        db.prepare(`
      INSERT INTO media_objects (
        id, world_id,
        kind, filename,
        mime_type, byte_size, sha256,
        storage, path,
        created_at, created_by_vault_user_id
      )
      VALUES (
        @id, @worldId,
        @kind, @filename,
        @mimeType, @byteSize, @sha256,
        @storage, @path,
        @now, @createdBy
      )
    `).run({
            id,
            worldId: toStr(args.worldId),
            kind: toStr(args.kind || "misc"),
            filename: toStr(args.filename || "upload"),
            mimeType: args.mimeType ?? null,
            byteSize: args.byteSize != null ? Math.trunc(Number(args.byteSize)) : null,
            sha256: args.sha256 ?? null,
            storage: toStr(args.storage ?? "vault"),
            path: toStr(args.path),
            now,
            createdBy: args.createdByVaultUserId ?? null,
        });
        const row = db.prepare(`
      SELECT *
      FROM media_objects
      WHERE id=? AND world_id=? AND deleted_at IS NULL
    `).get(id, toStr(args.worldId));
        return { ok: true, id, media: row ? rowToMediaObject(row) : null };
    }
    /* =========================================================
     * ATTACHMENTS
     * ========================================================= */
    attachMedia(args) {
        const id = `intel-attach:${uuid()}`;
        const now = nowIso();
        db.prepare(`
      INSERT INTO intel_attachments (
        id, world_id, intel_id,
        media_id, caption, sort_order,
        created_at
      )
      VALUES (
        @id, @worldId, @intelId,
        @mediaId, @caption, @sortOrder,
        @now
      )
    `).run({
            id,
            worldId: toStr(args.worldId),
            intelId: toStr(args.intelId),
            mediaId: toStr(args.mediaId),
            caption: args.caption ?? null,
            sortOrder: Math.trunc(Number(args.sortOrder ?? 0)),
            now
        });
        return { ok: true, id };
    }
    listAttachments(args) {
        const rows = db.prepare(`
    SELECT
      ia.id              AS attachment_id,
      ia.world_id        AS world_id,
      ia.intel_id        AS intel_id,
      ia.media_id        AS media_id,
      ia.caption         AS caption,
      ia.sort_order      AS sort_order,
      ia.created_at      AS created_at,

      mo.filename        AS filename,
      mo.mime_type       AS mime_type,
      mo.byte_size       AS byte_size,
      mo.path            AS path,
      mo.kind            AS media_kind
    FROM intel_attachments ia
    JOIN media_objects mo
      ON mo.id = ia.media_id
    WHERE ia.world_id = ?
      AND ia.intel_id = ?
      AND ia.deleted_at IS NULL
      AND mo.deleted_at IS NULL
    ORDER BY ia.sort_order ASC, ia.created_at ASC
  `).all(toStr(args.worldId), toStr(args.intelId));
        return rows.map((r) => ({
            // attachment identity
            id: r.attachment_id, // keep `id` as attachment id for your DELETE route
            attachmentId: r.attachment_id,
            worldId: r.world_id,
            intelId: r.intel_id,
            // media identity
            mediaId: r.media_id,
            filename: r.filename,
            mime: r.mime_type,
            byteSize: r.byte_size,
            path: r.path,
            url: `/media/${String(r.path).replace(/^\/+/, "")}`,
            // attachment fields
            caption: r.caption,
            sortOrder: Number(r.sort_order ?? 0),
            createdAt: r.created_at,
        }));
    }
    updateAttachment(args) {
        const sets = [];
        const params = { worldId: toStr(args.worldId), id: toStr(args.id) };
        if (Object.prototype.hasOwnProperty.call(args.patch, "caption")) {
            sets.push(`caption=@caption`);
            params.caption = args.patch.caption ?? null;
        }
        if (Object.prototype.hasOwnProperty.call(args.patch, "sortOrder")) {
            sets.push(`sort_order=@sortOrder`);
            params.sortOrder = Math.trunc(Number(args.patch.sortOrder ?? 0));
        }
        if (!sets.length)
            return { ok: false, error: "No fields to update" };
        db.prepare(`
      UPDATE intel_attachments
      SET ${sets.join(", ")}
      WHERE id=@id AND world_id=@worldId AND deleted_at IS NULL
    `).run(params);
        return { ok: true };
    }
    /**
     * Convenience reorder: pass ordered attachment ids and we set sort_order.
     */
    reorderAttachments(args) {
        const w = toStr(args.worldId);
        const intelId = toStr(args.intelId);
        const ids = (args.orderedIds ?? []).map(toStr).filter(Boolean);
        const tx = db.transaction(() => {
            for (let i = 0; i < ids.length; i++) {
                db.prepare(`
          UPDATE intel_attachments
          SET sort_order=?
          WHERE id=? AND world_id=? AND intel_id=? AND deleted_at IS NULL
        `).run(i, ids[i], w, intelId);
            }
        });
        tx();
        return { ok: true, count: ids.length };
    }
    detachMedia(args) {
        db.prepare(`
      UPDATE intel_attachments
      SET deleted_at=@now
      WHERE id=@id AND world_id=@worldId
    `).run({
            worldId: toStr(args.worldId),
            id: toStr(args.attachmentId),
            now: nowIso()
        });
        return { ok: true };
    }
    /* =========================================================
     * SOFT DELETE
     * ========================================================= */
    deleteIntel(args) {
        const now = nowIso();
        db.prepare(`
      UPDATE intel
      SET deleted_at=@now, updated_at=@now, updated_by_vault_user_id=@updatedBy
      WHERE id=@id AND world_id=@worldId
    `).run({
            id: toStr(args.id),
            worldId: toStr(args.worldId),
            now,
            updatedBy: args.updatedByVaultUserId ?? null
        });
        return { ok: true };
    }
}
export const intelStore = new IntelStore();
//# sourceMappingURL=intelStore.js.map